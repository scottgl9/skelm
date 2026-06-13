// In-workflow orchestration helpers (`ctx.workflows`, `ctx.tasks`) and the
// shared bounded-child runner behind them and `runDelegation`. Every child
// started here runs with `delegationCeiling` set to the calling step's
// resolved policy (optionally narrowed further, never widened), reusing the
// existing intersection, depth-cap, and cycle protections — no new
// permission math.

import type { BackendRegistry } from '../backend.js'
import {
  DEFAULT_MAX_DELEGATION_DEPTH,
  DelegationCycleError,
  DelegationDepthError,
  FanoutConfigError,
  FanoutFailedError,
  InvokePipelineNotFoundError,
  PermissionDeniedError,
  RunCancelledError,
  TaskOrchestrationError,
  serializeError,
} from '../errors.js'
import type { EventBus } from '../events.js'
import type {
  FanoutChildSpec,
  SpawnedTaskHandle,
  TaskSpawnOptions,
  TasksHandle,
  WorkflowFanoutOptions,
  WorkflowFanoutResult,
  WorkflowInvokeOptions,
  WorkflowInvokeResult,
  WorkflowsHandle,
} from '../orchestration-types.js'
import type { AgentPermissions, ResolvedPolicy } from '../permissions.js'
import { TrustEnforcer, intersectResolvedPolicies, resolvePermissions } from '../permissions.js'
import type { TaskRecord } from '../run-store/types.js'
import { generateRunId } from '../runner-utils.js'
import { runPipeline } from '../runner.js'
import type { Pipeline, Run } from '../types.js'
import type { ExecutionRuntime } from './runtime.js'

export const DEFAULT_FANOUT_CONCURRENCY = 4
export const MAX_FANOUT_CONCURRENCY = 16

/** Identity + authority of the step starting a bounded child run. */
export interface BoundedChildCaller {
  readonly runId: string
  readonly stepId: string
  readonly signal: AbortSignal
  /**
   * The caller's resolved policy. Gates `canDelegate(target)` and becomes the
   * child run's `delegationCeiling` (unless a narrower one is supplied), so
   * the child can never exceed the caller.
   */
  readonly policy: ResolvedPolicy
}

interface BoundedChildOptions {
  /** Ceiling applied to the child; must already be ≤ caller.policy (narrow via intersect). */
  readonly childCeiling?: ResolvedPolicy
  /** Overrides the caller's signal — used for detached task children. */
  readonly signal?: AbortSignal
  readonly runId?: string
  readonly taskId?: string
}

interface DelegationBounds {
  readonly stack: readonly string[]
  readonly depth: number
  readonly maxDepth: number
}

function assertDelegationBounds(
  pipelineId: string,
  caller: BoundedChildCaller,
  runtime: ExecutionRuntime,
  events: EventBus | undefined,
): DelegationBounds {
  const decision = new TrustEnforcer(caller.policy).canDelegate(pipelineId)
  if (!decision.allow) {
    events?.publish({
      type: 'permission.denied',
      runId: caller.runId,
      stepId: caller.stepId,
      dimension: 'delegation',
      detail: `delegate denied: ${pipelineId} — ${decision.reason}`,
      at: Date.now(),
    })
    throw new PermissionDeniedError(`delegation to "${pipelineId}" denied (${decision.reason})`)
  }
  const stack = runtime.delegationStack ?? []
  const depth = runtime.delegationDepth ?? 0
  const maxDepth = runtime.maxDelegationDepth ?? DEFAULT_MAX_DELEGATION_DEPTH
  if (depth + 1 > maxDepth) {
    throw new DelegationDepthError(pipelineId, depth + 1, maxDepth)
  }
  if (stack.includes(pipelineId)) {
    throw new DelegationCycleError(pipelineId, stack)
  }
  return { stack, depth, maxDepth }
}

function executeBoundedChild(
  pipeline: Pipeline,
  pipelineId: string,
  input: unknown,
  caller: BoundedChildCaller,
  runtime: ExecutionRuntime,
  bounds: DelegationBounds,
  backends: BackendRegistry | undefined,
  events: EventBus | undefined,
  opts: BoundedChildOptions,
): Promise<Run> {
  return runPipeline(pipeline, input, {
    signal: opts.signal ?? caller.signal,
    ...(opts.runId !== undefined && { runId: opts.runId }),
    parentRunId: caller.runId,
    parentStepId: caller.stepId,
    ...(opts.taskId !== undefined && { taskId: opts.taskId }),
    ...(events !== undefined && { events }),
    ...(backends !== undefined && { backends }),
    ...(runtime.store !== undefined && { store: runtime.store }),
    ...(runtime.stateStore !== undefined && { stateStore: runtime.stateStore }),
    ...(runtime.defaultPermissions !== undefined && {
      defaultPermissions: runtime.defaultPermissions,
    }),
    ...(runtime.permissionProfiles !== undefined && {
      permissionProfiles: runtime.permissionProfiles,
    }),
    ...(runtime.executableProfiles !== undefined && {
      executableProfiles: runtime.executableProfiles,
    }),
    ...(runtime.unrestrictedGrant !== undefined && {
      unrestrictedGrant: runtime.unrestrictedGrant,
    }),
    ...(runtime.workspaceManager !== undefined && { workspaceManager: runtime.workspaceManager }),
    ...(runtime.skillSource !== undefined && { skillSource: runtime.skillSource }),
    ...(runtime.secretResolver !== undefined && { secretResolver: runtime.secretResolver }),
    ...(runtime.pipelineRegistry !== undefined && { pipelineRegistry: runtime.pipelineRegistry }),
    delegationCeiling: opts.childCeiling ?? caller.policy,
    delegationStack: [...bounds.stack, pipelineId],
    delegationDepth: bounds.depth + 1,
    maxDelegationDepth: bounds.maxDepth,
  })
}

/**
 * Run a registered pipeline as a permission-bounded child of `caller`.
 * Enforces the caller's `delegation` allowlist, the delegation depth cap, and
 * cycle refusal before any child run starts, then runs the child with
 * `delegationCeiling` = the caller's resolved policy (or the supplied
 * narrower ceiling). Shared by `runDelegation`, `ctx.workflows`, and
 * `ctx.tasks.spawn`.
 */
export async function runBoundedChild(
  pipelineId: string,
  input: unknown,
  caller: BoundedChildCaller,
  runtime: ExecutionRuntime,
  backends: BackendRegistry | undefined,
  events?: EventBus,
  opts: BoundedChildOptions = {},
): Promise<Run> {
  const bounds = assertDelegationBounds(pipelineId, caller, runtime, events)
  const pipeline = await runtime.pipelineRegistry?.(pipelineId)
  if (pipeline === undefined) {
    throw new InvokePipelineNotFoundError(pipelineId, caller.stepId)
  }
  return executeBoundedChild(
    pipeline,
    pipelineId,
    input,
    caller,
    runtime,
    bounds,
    backends,
    events,
    opts,
  )
}

/** Wiring the runner hands the handle factories for one code step. */
export interface OrchestrationWiring {
  readonly caller: BoundedChildCaller
  readonly runtime: ExecutionRuntime
  readonly backends?: BackendRegistry
  readonly events?: EventBus
}

function makeCeilingResolver(
  wiring: OrchestrationWiring,
): (req?: AgentPermissions) => ResolvedPolicy {
  return (requested?: AgentPermissions): ResolvedPolicy => {
    if (requested === undefined) return wiring.caller.policy
    // Narrowing only: the requested ceiling resolves without the operator's
    // unrestricted grant and is intersected with the caller's policy, so a
    // caller-supplied ceiling can never widen past the caller itself.
    const resolved = resolvePermissions(
      undefined,
      requested,
      wiring.runtime.permissionProfiles ?? {},
      {
        ...(wiring.runtime.executableProfiles !== undefined && {
          executableProfiles: wiring.runtime.executableProfiles,
        }),
      },
    )
    return intersectResolvedPolicies(wiring.caller.policy, resolved)
  }
}

function toInvokeResult<TOutput>(run: Run, workflowId: string): WorkflowInvokeResult<TOutput> {
  if (run.status === 'completed') {
    return {
      status: 'completed',
      workflowId,
      runId: run.runId,
      output: run.output as TOutput,
    }
  }
  return {
    status: run.status === 'cancelled' ? 'cancelled' : 'failed',
    workflowId,
    runId: run.runId,
    ...(run.error !== undefined && { error: run.error }),
  }
}

export function createWorkflowsHandle(wiring: OrchestrationWiring): WorkflowsHandle {
  const resolveCeiling = makeCeilingResolver(wiring)
  return {
    async invoke<TOutput = unknown>(
      opts: WorkflowInvokeOptions,
    ): Promise<WorkflowInvokeResult<TOutput>> {
      const run = await runBoundedChild(
        opts.pipelineId,
        opts.input,
        wiring.caller,
        wiring.runtime,
        wiring.backends,
        wiring.events,
        { childCeiling: resolveCeiling(opts.ceiling) },
      )
      return toInvokeResult<TOutput>(run, opts.pipelineId)
    },
    fanout<TOutput = unknown>(opts: WorkflowFanoutOptions): Promise<WorkflowFanoutResult<TOutput>> {
      return runFanout<TOutput>(opts, wiring, resolveCeiling)
    },
  }
}

function normalizeFanoutChildren(opts: WorkflowFanoutOptions): readonly FanoutChildSpec[] {
  if (opts.items !== undefined) {
    if (opts.pipelineId !== undefined || opts.inputs !== undefined) {
      throw new FanoutConfigError(
        'fanout: `items` is mutually exclusive with `pipelineId`/`inputs`',
      )
    }
    if (opts.items.length === 0) throw new FanoutConfigError('fanout: `items` is empty')
    return opts.items
  }
  if (opts.pipelineId === undefined) {
    throw new FanoutConfigError('fanout: supply either `pipelineId` (+ `inputs`) or `items`')
  }
  const inputs = opts.inputs ?? []
  if (inputs.length === 0) throw new FanoutConfigError('fanout: `inputs` is empty')
  const pipelineId = opts.pipelineId
  return inputs.map((input) => ({ pipelineId, input }))
}

function normalizeFanoutConcurrency(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_FANOUT_CONCURRENCY
  if (!Number.isInteger(requested) || requested < 1) {
    throw new FanoutConfigError(`fanout: concurrency must be a positive integer, got ${requested}`)
  }
  return Math.min(requested, MAX_FANOUT_CONCURRENCY)
}

async function runFanout<TOutput>(
  opts: WorkflowFanoutOptions,
  wiring: OrchestrationWiring,
  resolveCeiling: (req?: AgentPermissions) => ResolvedPolicy,
): Promise<WorkflowFanoutResult<TOutput>> {
  const children = normalizeFanoutChildren(opts)
  const strategy = opts.strategy ?? 'wait-all'
  const concurrency = normalizeFanoutConcurrency(opts.concurrency)
  if (strategy === 'quorum') {
    if (
      opts.quorum === undefined ||
      !Number.isInteger(opts.quorum) ||
      opts.quorum < 1 ||
      opts.quorum > children.length
    ) {
      throw new FanoutConfigError(
        `fanout: \`quorum\` must be an integer in [1, ${children.length}], got ${opts.quorum}`,
      )
    }
  }
  if (strategy === 'ranked-merge' && typeof opts.rank !== 'function') {
    throw new FanoutConfigError('fanout: `ranked-merge` requires a `rank` comparator')
  }
  const childCeiling = resolveCeiling(opts.ceiling)
  const quorumTarget = strategy === 'quorum' ? (opts.quorum as number) : undefined

  const results: (WorkflowInvokeResult<TOutput> | undefined)[] = new Array(children.length).fill(
    undefined,
  )
  const controllers: (AbortController | undefined)[] = new Array(children.length).fill(undefined)
  let stopped = false
  let callerError: unknown
  let successCount = 0
  let failureCount = 0

  const cancelRest = (): void => {
    stopped = true
    for (const controller of controllers) {
      controller?.abort(new RunCancelledError('fanout: sibling outcome cancelled this child'))
    }
  }

  const runChild = async (index: number): Promise<void> => {
    const child = children[index]
    if (child === undefined) return
    const controller = new AbortController()
    controllers[index] = controller
    // Re-check after registering the controller: cancelRest may have run
    // between this worker taking the index and the controller existing.
    if (stopped) controller.abort(new RunCancelledError('fanout: cancelled before start'))
    if (wiring.caller.signal.aborted) controller.abort(wiring.caller.signal.reason)
    const onAbort = () => controller.abort(wiring.caller.signal.reason)
    wiring.caller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const run = await runBoundedChild(
        child.pipelineId,
        child.input,
        wiring.caller,
        wiring.runtime,
        wiring.backends,
        wiring.events,
        { childCeiling, signal: controller.signal },
      )
      const result = toInvokeResult<TOutput>(run, child.pipelineId)
      results[index] = result
      if (result.status === 'completed') {
        successCount++
        if (
          strategy === 'first-success' ||
          (quorumTarget !== undefined && successCount >= quorumTarget)
        ) {
          cancelRest()
        }
      } else {
        failureCount++
        if (strategy === 'fail-fast') cancelRest()
        if (quorumTarget !== undefined && children.length - failureCount < quorumTarget) {
          cancelRest()
        }
      }
    } finally {
      wiring.caller.signal.removeEventListener('abort', onAbort)
    }
  }

  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (!stopped) {
      const index = nextIndex++
      if (index >= children.length) return
      try {
        await runChild(index)
      } catch (err) {
        // Caller-side refusals (permission/depth/cycle/unknown pipeline) abort
        // the whole fanout regardless of strategy — strategies only merge
        // child RUN outcomes, never mask a denied start.
        if (callerError === undefined) callerError = err
        cancelRest()
        return
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, children.length) }, () => worker()))
  if (callerError !== undefined) throw callerError
  if (wiring.caller.signal.aborted) throw new RunCancelledError('fanout: run was cancelled')

  const settled = results.filter((r): r is WorkflowInvokeResult<TOutput> => r !== undefined)
  const successes = settled.filter((r) => r.status === 'completed')
  const failures = settled.filter((r) => r.status !== 'completed')

  switch (strategy) {
    case 'wait-all': {
      if (failures.length > 0 && opts.continueOnError !== true) {
        throw new FanoutFailedError(
          `fanout(wait-all): ${failures.length} of ${children.length} children did not complete`,
          results,
        )
      }
      return {
        status: failures.length === 0 ? 'completed' : 'failed',
        results,
        successes,
        failures,
      }
    }
    case 'fail-fast': {
      if (failures.length > 0) {
        throw new FanoutFailedError(
          `fanout(fail-fast): child run ${failures[0]?.runId} did not complete`,
          results,
        )
      }
      return { status: 'completed', results, successes, failures }
    }
    case 'best-effort':
      return {
        status: successes.length > 0 ? 'completed' : 'failed',
        results,
        successes,
        failures,
      }
    case 'quorum': {
      if (successes.length < (quorumTarget as number)) {
        throw new FanoutFailedError(
          `fanout(quorum): only ${successes.length} of required ${quorumTarget} children completed`,
          results,
        )
      }
      return { status: 'completed', results, successes, failures }
    }
    case 'first-success': {
      if (successes.length === 0) {
        throw new FanoutFailedError('fanout(first-success): no child completed', results)
      }
      return { status: 'completed', results, successes, failures }
    }
    case 'ranked-merge': {
      const rank = opts.rank as (a: WorkflowInvokeResult, b: WorkflowInvokeResult) => number
      const ordered = [...settled].sort(rank)
      return {
        status: failures.length === 0 ? 'completed' : 'failed',
        results: ordered,
        successes,
        failures,
      }
    }
    default: {
      const exhaustive: never = strategy
      throw new FanoutConfigError(`fanout: unknown strategy ${String(exhaustive)}`)
    }
  }
}

const TERMINAL_TASK_STATUSES = new Set<TaskRecord['status']>(['completed', 'failed', 'cancelled'])
const TASK_WAIT_POLL_MS = 50

function abortableWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new RunCancelledError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RunCancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

interface LocalTask {
  readonly childRunId: string
  readonly controller: AbortController
  readonly done: Promise<void>
}

export function createTasksHandle(wiring: OrchestrationWiring): TasksHandle {
  const { caller, runtime, backends, events } = wiring
  const store = runtime.store
  const resolveCeiling = makeCeilingResolver(wiring)
  const local = new Map<string, LocalTask>()

  const requireStore = (op: string): NonNullable<ExecutionRuntime['store']> => {
    if (store === undefined) {
      throw new TaskOrchestrationError(`ctx.tasks.${op} requires a task-capable run store`)
    }
    return store
  }

  const finalizeTask = async (taskId: string, childRunId: string, run: Run): Promise<void> => {
    const taskStore = requireStore('spawn')
    const current = await taskStore.getTask(taskId)
    if (current === null || TERMINAL_TASK_STATUSES.has(current.status)) return
    const status =
      run.status === 'completed' ? 'completed' : run.status === 'cancelled' ? 'cancelled' : 'failed'
    await taskStore.updateTask(taskId, {
      status,
      completedAt: new Date().toISOString(),
      ...(run.error !== undefined && { error: run.error }),
    })
    const base = { runId: caller.runId, taskId, childRunId, at: Date.now() }
    if (status === 'completed') events?.publish({ type: 'task.completed', ...base })
    else if (status === 'cancelled') events?.publish({ type: 'task.cancelled', ...base })
    else
      events?.publish({
        type: 'task.failed',
        ...base,
        error: run.error ?? serializeError(new Error('task failed')),
      })
  }

  const markSpawnFailure = async (
    taskId: string,
    childRunId: string,
    err: unknown,
  ): Promise<void> => {
    const taskStore = requireStore('spawn')
    const current = await taskStore.getTask(taskId)
    if (current === null || TERMINAL_TASK_STATUSES.has(current.status)) return
    const error = serializeError(err)
    await taskStore.updateTask(taskId, {
      status: 'failed',
      error,
      completedAt: new Date().toISOString(),
    })
    events?.publish({
      type: 'task.failed',
      runId: caller.runId,
      taskId,
      childRunId,
      error,
      at: Date.now(),
    })
  }

  return {
    async spawn(opts: TaskSpawnOptions): Promise<SpawnedTaskHandle> {
      const taskStore = requireStore('spawn')
      // Same gate as delegation: spawning a detached task is a privileged
      // hand-off, default-denied unless the step's `delegation` allowlist
      // grants the target workflow id.
      const bounds = assertDelegationBounds(opts.workflowId, caller, runtime, events)
      const pipeline = await runtime.pipelineRegistry?.(opts.workflowId)
      if (pipeline === undefined) {
        throw new InvokePipelineNotFoundError(opts.workflowId, caller.stepId)
      }
      const childCeiling = resolveCeiling(opts.ceiling)
      const taskId = `task_${generateRunId()}`
      const childRunId = generateRunId()
      await taskStore.putTask({
        taskId,
        workflowId: opts.workflowId,
        status: 'pending',
        parentRunId: caller.runId,
        parentStepId: caller.stepId,
        ...(opts.input !== undefined && { input: opts.input }),
        ...(opts.deliveryTarget !== undefined && { deliveryTarget: opts.deliveryTarget }),
        createdAt: new Date().toISOString(),
      })
      // Detached: the child gets its own controller, NOT chained to the
      // parent step's signal — it outlives the step and is cancelled only via
      // ctx.tasks.cancel or the gateway tasks API. It is still ceiling-bound.
      const controller = new AbortController()
      const childRun = executeBoundedChild(
        pipeline,
        opts.workflowId,
        opts.input,
        caller,
        runtime,
        bounds,
        backends,
        events,
        { childCeiling, signal: controller.signal, runId: childRunId, taskId },
      )
      await taskStore.updateTask(taskId, {
        status: 'running',
        childRunId,
        startedAt: new Date().toISOString(),
      })
      events?.publish({
        type: 'task.created',
        runId: caller.runId,
        taskId,
        childRunId,
        at: Date.now(),
      })
      const done = childRun
        .then((run) => finalizeTask(taskId, childRunId, run))
        .catch((err) =>
          markSpawnFailure(taskId, childRunId, err).catch((storeErr) => {
            console.error(
              `skelm: task ${taskId} failure could not be recorded:`,
              (storeErr as Error)?.message ?? storeErr,
            )
          }),
        )
      local.set(taskId, { childRunId, controller, done })
      return { taskId, childRunId }
    },

    async wait(taskId: string): Promise<TaskRecord> {
      const taskStore = requireStore('wait')
      const entry = local.get(taskId)
      if (entry !== undefined) {
        await abortableWait(entry.done, caller.signal)
        const task = await taskStore.getTask(taskId)
        if (task === null) throw new TaskOrchestrationError(`task "${taskId}" not found`)
        return task
      }
      for (;;) {
        const task = await taskStore.getTask(taskId)
        if (task === null) throw new TaskOrchestrationError(`task "${taskId}" not found`)
        if (TERMINAL_TASK_STATUSES.has(task.status)) return task
        await abortableWait(sleep(TASK_WAIT_POLL_MS), caller.signal)
      }
    },

    async cancel(taskId: string): Promise<void> {
      const taskStore = requireStore('cancel')
      const entry = local.get(taskId)
      if (entry === undefined) {
        throw new TaskOrchestrationError(
          `task "${taskId}" was not spawned by this step; cancel it via the gateway tasks API`,
        )
      }
      const current = await taskStore.getTask(taskId)
      if (current !== null && TERMINAL_TASK_STATUSES.has(current.status)) return
      entry.controller.abort(new RunCancelledError(`task ${taskId} cancelled`))
      await taskStore.updateTask(taskId, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
      })
      events?.publish({
        type: 'task.cancelled',
        runId: caller.runId,
        taskId,
        childRunId: entry.childRunId,
        at: Date.now(),
      })
    },

    stream(taskId, onEvent): () => void {
      const entry = local.get(taskId)
      if (entry === undefined) {
        throw new TaskOrchestrationError(`task "${taskId}" was not spawned by this step`)
      }
      if (events === undefined) {
        throw new TaskOrchestrationError('ctx.tasks.stream requires an event bus')
      }
      return events.forRun(entry.childRunId, onEvent)
    },
  }
}
