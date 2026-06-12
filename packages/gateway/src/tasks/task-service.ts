import { randomUUID } from 'node:crypto'
import {
  type DeliveryTarget,
  type RunEvent,
  type RunStore,
  type SerializedError,
  type TaskFilter,
  type TaskRecord,
  serializeError,
} from '@skelm/core'
import type { GatewayContext } from '../lifecycle/gateway-types.js'

/** Raised for client-facing task errors; carries an HTTP status code. */
export class TaskError extends Error {
  override readonly name = 'TaskError'
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

const TERMINAL_RUN_EVENTS = new Set<RunEvent['type']>([
  'run.completed',
  'run.failed',
  'run.cancelled',
])

export interface CreateTaskInput {
  workflowId: string
  input?: unknown
  parentRunId?: string
  parentStepId?: string
  parentSessionId?: string
  deliveryTarget?: DeliveryTarget
}

/**
 * Owns the detached-task lifecycle on top of the gateway: create + dispatch a
 * child run, cancel, retry, and reconcile task status from the child run's
 * terminal events. The child run executes through the gateway's normal run
 * dispatch path with its own declared permissions — there is no permission
 * inheritance in this phase.
 *
 * Every write is audited through the single gateway audit writer. The bearer
 * auth on the control surface gates access; this service does not re-check it.
 */
export class TaskService {
  private readonly store: RunStore
  private unsubscribe: (() => void) | undefined

  constructor(private readonly gateway: GatewayContext) {
    this.store = gateway.runStore
  }

  /** Subscribe to the gateway event bus so child-run completion transitions tasks. */
  start(): void {
    if (this.unsubscribe !== undefined) return
    this.unsubscribe = this.gateway.events.subscribe((event) => {
      if (!TERMINAL_RUN_EVENTS.has(event.type)) return
      void this.onChildRunTerminal(event).catch((err) => {
        console.error('gateway: task completion linkage failed:', (err as Error)?.message ?? err)
      })
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    const task = await this.store.getTask(taskId)
    if (task === null) throw new TaskError(404, 'task not found')
    return task
  }

  async listTasks(filter: TaskFilter): Promise<readonly TaskRecord[]> {
    return this.store.listTasks(filter)
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    if (typeof input.workflowId !== 'string' || input.workflowId.length === 0) {
      throw new TaskError(400, 'workflowId is required')
    }
    if (this.gateway.registries.workflows.get(input.workflowId) === undefined) {
      throw new TaskError(404, `workflow not found: ${input.workflowId}`)
    }

    const taskId = `task_${randomUUID()}`
    const now = new Date().toISOString()
    const pending: TaskRecord = {
      taskId,
      workflowId: input.workflowId,
      status: 'pending',
      ...(input.input !== undefined && { input: input.input }),
      ...(input.parentRunId !== undefined && { parentRunId: input.parentRunId }),
      ...(input.parentStepId !== undefined && { parentStepId: input.parentStepId }),
      ...(input.parentSessionId !== undefined && { parentSessionId: input.parentSessionId }),
      ...(input.deliveryTarget !== undefined && { deliveryTarget: input.deliveryTarget }),
      createdAt: now,
    }
    await this.store.putTask(pending)

    let runId: string
    try {
      const dispatched = await this.gateway.startPipelineAsync(
        input.workflowId,
        input.input ?? {},
        {
          ...(input.parentRunId !== undefined && { parentRunId: input.parentRunId }),
          ...(input.parentStepId !== undefined && { parentStepId: input.parentStepId }),
          taskId,
        },
      )
      runId = dispatched.runId
    } catch (err) {
      const error = serializeError(err)
      await this.store.updateTask(taskId, {
        status: 'failed',
        error,
        completedAt: new Date().toISOString(),
      })
      this.emit({ type: 'task.failed', taskId, error, eventRunId: input.parentRunId })
      throw new TaskError(
        typeof (err as { statusCode?: unknown }).statusCode === 'number'
          ? (err as { statusCode: number }).statusCode
          : 500,
        (err as Error).message,
      )
    }

    await this.store.updateTask(taskId, {
      status: 'running',
      childRunId: runId,
      startedAt: new Date().toISOString(),
    })
    await this.audit('task.create', input.parentRunId, {
      taskId,
      workflowId: input.workflowId,
      runId,
    })
    this.emit({
      type: 'task.created',
      taskId,
      childRunId: runId,
      eventRunId: input.parentRunId,
    })

    const created = await this.store.getTask(taskId)
    if (created === null) throw new TaskError(500, 'task vanished after creation')
    return created
  }

  async cancelTask(taskId: string): Promise<TaskRecord> {
    const task = await this.getTask(taskId)
    if (isTerminal(task.status)) {
      throw new TaskError(409, `task is already ${task.status}`)
    }
    if (task.childRunId !== undefined) {
      this.gateway.cancel(task.childRunId, `task ${taskId} cancelled`)
    }
    await this.store.updateTask(taskId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    })
    await this.audit('task.cancel', task.parentRunId, { taskId, childRunId: task.childRunId })
    this.emit({
      type: 'task.cancelled',
      taskId,
      ...(task.childRunId !== undefined && { childRunId: task.childRunId }),
      eventRunId: task.parentRunId,
    })
    return this.getTask(taskId)
  }

  async retryTask(taskId: string): Promise<TaskRecord> {
    const task = await this.getTask(taskId)
    if (task.status !== 'failed' && task.status !== 'cancelled') {
      throw new TaskError(409, `task is ${task.status}; only failed or cancelled tasks can retry`)
    }
    const retried = await this.createTask({
      workflowId: task.workflowId,
      ...(task.input !== undefined && { input: task.input }),
      ...(task.parentRunId !== undefined && { parentRunId: task.parentRunId }),
      ...(task.parentStepId !== undefined && { parentStepId: task.parentStepId }),
      ...(task.parentSessionId !== undefined && { parentSessionId: task.parentSessionId }),
      ...(task.deliveryTarget !== undefined && { deliveryTarget: task.deliveryTarget }),
    })
    await this.store.updateTask(retried.taskId, { retryOfTaskId: taskId })
    await this.audit('task.retry', task.parentRunId, { taskId, retryTaskId: retried.taskId })
    const updated = await this.store.getTask(retried.taskId)
    return updated ?? retried
  }

  /**
   * Reconcile tasks whose child run is terminal but whose own status was left
   * `running` (e.g. a crash between run finalization and task update). Called
   * on gateway boot, after run recovery. Idempotent.
   */
  async reconcile(): Promise<{ reconciled: readonly string[] }> {
    const reconciled: string[] = []
    const running = await this.store.listTasks({ status: 'running' })
    for (const task of running) {
      if (task.childRunId === undefined) continue
      const run = await this.store.getRun(task.childRunId)
      if (run === null) continue
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
        await this.transitionFromRunStatus(task, run.status, run.error ?? undefined)
        reconciled.push(task.taskId)
      }
    }
    return { reconciled }
  }

  private async onChildRunTerminal(event: RunEvent): Promise<void> {
    // Match across non-terminal task states: a very fast child run can reach a
    // terminal event before createTask flips the task from pending to running.
    const candidates = [
      ...(await this.store.listTasks({ status: 'running' })),
      ...(await this.store.listTasks({ status: 'pending' })),
    ]
    const match = candidates.find((t) => t.childRunId === event.runId)
    if (match === undefined || isTerminal(match.status)) return
    const status =
      event.type === 'run.completed'
        ? 'completed'
        : event.type === 'run.failed'
          ? 'failed'
          : 'cancelled'
    const error = event.type === 'run.failed' ? event.error : undefined
    await this.transitionFromRunStatus(match, status, error)
  }

  private async transitionFromRunStatus(
    task: TaskRecord,
    status: 'completed' | 'failed' | 'cancelled',
    error: SerializedError | undefined,
  ): Promise<void> {
    const completedAt = new Date().toISOString()
    await this.store.updateTask(task.taskId, {
      status,
      completedAt,
      ...(error !== undefined && { error }),
    })
    if (status === 'completed') {
      this.emit({
        type: 'task.completed',
        taskId: task.taskId,
        ...(task.childRunId !== undefined && { childRunId: task.childRunId }),
        ...(task.summary !== undefined && { summary: task.summary }),
        eventRunId: task.parentRunId,
      })
    } else if (status === 'failed') {
      this.emit({
        type: 'task.failed',
        taskId: task.taskId,
        ...(task.childRunId !== undefined && { childRunId: task.childRunId }),
        error: error ?? serializeError(new Error('task failed')),
        eventRunId: task.parentRunId,
      })
    } else {
      this.emit({
        type: 'task.cancelled',
        taskId: task.taskId,
        ...(task.childRunId !== undefined && { childRunId: task.childRunId }),
        eventRunId: task.parentRunId,
      })
    }
  }

  private emit(
    args:
      | {
          type: 'task.created'
          taskId: string
          childRunId?: string
          eventRunId: string | undefined
        }
      | {
          type: 'task.completed'
          taskId: string
          childRunId?: string
          summary?: string
          eventRunId: string | undefined
        }
      | {
          type: 'task.failed'
          taskId: string
          childRunId?: string
          error: SerializedError
          eventRunId: string | undefined
        }
      | {
          type: 'task.cancelled'
          taskId: string
          childRunId?: string
          eventRunId: string | undefined
        },
  ): void {
    // The event rides on the parent run's bus when spawned from a run, else on
    // the child run's bus so a SSE subscriber on the child sees it.
    const runId = args.eventRunId ?? args.childRunId
    if (runId === undefined) return
    const at = Date.now()
    const base = {
      runId,
      taskId: args.taskId,
      ...(args.childRunId !== undefined && { childRunId: args.childRunId }),
      at,
    }
    const event: RunEvent =
      args.type === 'task.completed'
        ? {
            type: 'task.completed',
            ...base,
            ...(args.summary !== undefined && { summary: args.summary }),
          }
        : args.type === 'task.failed'
          ? { type: 'task.failed', ...base, error: args.error }
          : args.type === 'task.created'
            ? { type: 'task.created', ...base }
            : { type: 'task.cancelled', ...base }

    // Publish for live SSE subscribers. The per-run Runner persists events it
    // sees on the bus only while the run is in flight; once the run is terminal
    // its store subscriber is gone, so append the event ourselves to keep the
    // child run's durable event log complete. Checking the in-flight runner
    // makes this exactly-once: publish-only while running, append-only after.
    const runActive =
      args.childRunId !== undefined && this.gateway.getRunner(args.childRunId) !== undefined
    this.gateway.events.publish(event)
    if (!runActive) {
      void this.store.appendEvent(event).catch((err) => {
        console.error('gateway: task event persist failed:', (err as Error)?.message ?? err)
      })
    }
  }

  private async audit(
    action: string,
    runId: string | undefined,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.gateway.enforcement.auditWriter.write({
      actor: 'gateway',
      action,
      ...(runId !== undefined && { runId }),
      details,
    })
  }
}

function isTerminal(status: TaskRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
