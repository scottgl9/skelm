import type { Pipeline, Run, RunStore } from '@skelm/core'
import parser from 'cron-parser'
import type {
  CronTrigger,
  IntervalTrigger,
  SchedulerConfig,
  Trigger,
  TriggerContext,
  TriggerRegistration,
} from './types.js'

const MAX_INTERVAL_MS = 2_147_483_647

/** The slice of `RunStore` the scheduler depends on for recording triggered runs. */
export type SchedulerRunStore = Pick<RunStore, 'putRun'>

/** Resolves a registered pipeline ID to the executable pipeline, or `null` if unknown. */
export type SchedulerPipelineLoader = (pipelineId: string) => Promise<Pipeline | null>

/**
 * Executes a loaded pipeline for a trigger fire. Must return the terminal
 * Run record (with status set to one of `completed`, `failed`, or
 * `cancelled` and `completedAt` populated) so the scheduler can persist a
 * complete entry. When omitted, fires register the trigger metadata but
 * do not produce Run records — see Scheduler.executeTrigger.
 */
export type SchedulerPipelineExecutor = (
  pipeline: Pipeline,
  input: unknown,
  ctx: TriggerContext,
) => Promise<Run>

type SchedulerDeps = {
  runStore: SchedulerRunStore
  pipelineLoader?: SchedulerPipelineLoader
  pipelineExecutor?: SchedulerPipelineExecutor
}

type LegacySchedulerConfig = SchedulerConfig & SchedulerDeps

type LegacyTrigger = {
  id: string
  kind: Trigger['type']
  workflowId: string
  cron?: string
  schedule?: string
  timezone?: string
  intervalMs?: number
  initialDelayMs?: number
  path?: string
  secret?: string
  transformPayload?: (payload: unknown) => unknown
  enabled?: boolean
  description?: string
  dedupe?: Trigger['dedupe']
  overlap?: Trigger['overlap']
  maxConcurrent?: number
  inputTemplate?: unknown
  metadata?: Record<string, unknown>
}

/**
 * Scheduler manages long-running triggers for pipelines.
 * Handles cron, interval, and webhook triggers with overlap policies.
 */
export class Scheduler {
  private readonly config: SchedulerConfig
  private readonly triggers = new Map<string, TriggerRegistration>()
  private readonly cronJobs = new Map<string, NodeJS.Timeout>()
  private readonly intervalJobs = new Map<string, NodeJS.Timeout>()
  private webhookServer: unknown | null = null
  private readonly inFlight = new Set<Promise<unknown>>()
  private readonly runningCount = new Map<string, number>()
  private readonly lastRun = new Map<string, Promise<void>>()
  private isRunning = false
  private readonly runStore: SchedulerRunStore
  private readonly pipelineLoader: SchedulerPipelineLoader
  private readonly pipelineExecutor: SchedulerPipelineExecutor | undefined
  private readonly noExecutorWarned = new Set<string>()

  constructor(config: SchedulerConfig, deps: SchedulerDeps)
  constructor(config: LegacySchedulerConfig)
  constructor(config: SchedulerConfig | LegacySchedulerConfig, deps?: SchedulerDeps) {
    const resolvedDeps = deps ?? extractLegacyDeps(config)
    const cfg: SchedulerConfig = {
      webhookPort: config.webhookPort ?? 3001,
      webhookHost: config.webhookHost ?? '127.0.0.1',
      pollConcurrency: config.pollConcurrency ?? 5,
      queuePollIntervalMs: config.queuePollIntervalMs ?? 5000,
    }
    if (config.dbPath !== undefined) {
      cfg.dbPath = config.dbPath
    }
    this.config = cfg
    this.runStore = resolvedDeps.runStore
    this.pipelineLoader = resolvedDeps.pipelineLoader ?? (async () => null)
    this.pipelineExecutor = resolvedDeps.pipelineExecutor
  }

  /** Register a new trigger */
  async register(trigger: Trigger | LegacyTrigger): Promise<TriggerRegistration> {
    const normalized = normalizeTrigger(trigger)
    if (normalized.maxConcurrent !== undefined && normalized.maxConcurrent < 1) {
      throw new RangeError(`maxConcurrent must be >= 1, got ${normalized.maxConcurrent}`)
    }
    const registration: TriggerRegistration = {
      trigger: normalized,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runCount: 0,
      errorCount: 0,
      status: 'active',
    }

    this.triggers.set(normalized.id, registration)

    switch (normalized.type) {
      case 'cron':
        this.startCronTrigger(normalized)
        break
      case 'interval':
        this.startIntervalTrigger(normalized)
        break
      case 'webhook':
        // Webhook server starts separately via startWebhookServer()
        break
    }

    return registration
  }

  /** Unregister a trigger */
  async unregister(triggerId: string): Promise<void> {
    const registration = this.triggers.get(triggerId)
    if (!registration) return

    this.stopCronTrigger(triggerId)
    this.stopIntervalTrigger(triggerId)

    this.lastRun.delete(triggerId)
    this.runningCount.delete(triggerId)
    this.triggers.delete(triggerId)
  }

  /** Pause a trigger */
  async pause(triggerId: string): Promise<void> {
    const registration = this.triggers.get(triggerId)
    if (!registration) return

    registration.status = 'paused'
    registration.updatedAt = Date.now()

    this.stopCronTrigger(triggerId)
    this.stopIntervalTrigger(triggerId)
  }

  /** Resume a paused trigger */
  async resume(triggerId: string): Promise<void> {
    const registration = this.triggers.get(triggerId)
    if (!registration) return
    if (registration.status !== 'paused') return

    registration.status = 'active'
    registration.updatedAt = Date.now()
    const trigger = registration.trigger

    switch (trigger.type) {
      case 'cron':
        this.startCronTrigger(trigger)
        break
      case 'interval':
        this.startIntervalTrigger(trigger)
        break
    }
  }

  /** List all registered triggers */
  listTriggers(): TriggerRegistration[] {
    return [...this.triggers.values()]
  }

  /** Get a specific trigger registration */
  getTrigger(triggerId: string): TriggerRegistration | undefined {
    return this.triggers.get(triggerId)
  }

  /** Start the webhook server */
  async startWebhookServer(): Promise<void> {
    console.log(
      `Webhook server would start on ${this.config.webhookHost}:${this.config.webhookPort}`,
    )
  }

  /** Stop the webhook server */
  async stopWebhookServer(): Promise<void> {
    this.webhookServer = null
  }

  /** Start all triggers */
  async start(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true

    for (const registration of this.triggers.values()) {
      if (registration.status === 'active') {
        const trigger = registration.trigger
        switch (trigger.type) {
          case 'cron':
            this.startCronTrigger(trigger)
            break
          case 'interval':
            this.startIntervalTrigger(trigger)
            break
        }
      }
    }
  }

  /**
   * Stop all triggers. Clears the timers, then waits up to 30s for any
   * in-flight executeTrigger callbacks to settle so a SIGTERM does not
   * leave fire-and-forget executions racing the process exit.
   *
   * Runs unconditionally — `register()` arms timers immediately without
   * setting isRunning, so a stop() that gated on isRunning would leak
   * those timers when the scheduler is constructed without start().
   */
  async stop(): Promise<void> {
    this.isRunning = false

    for (const [id, job] of this.cronJobs) {
      clearTimeout(job)
      this.cronJobs.delete(id)
    }
    for (const [id, job] of this.intervalJobs) {
      clearInterval(job)
      this.intervalJobs.delete(id)
    }

    await this.drainInFlight(30_000)
  }

  /** Track a fire-and-forget execution so stop() can drain it. */
  private track(promise: Promise<unknown>): void {
    this.inFlight.add(promise)
    promise.finally(() => this.inFlight.delete(promise))
  }

  private async drainInFlight(timeoutMs: number): Promise<void> {
    if (this.inFlight.size === 0) return
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ])
  }

  private startCronTrigger(trigger: CronTrigger): void {
    this.stopCronTrigger(trigger.id)
    this.scheduleNextCron(trigger)
  }

  private scheduleNextCron(trigger: CronTrigger): void {
    let delay: number
    try {
      const opts: parser.ParserOptions = { currentDate: new Date() }
      if (trigger.timezone !== undefined) opts.tz = trigger.timezone
      const next = parser.parseExpression(trigger.schedule, opts).next().getTime()
      delay = Math.max(0, next - Date.now())
    } catch (err) {
      const registration = this.triggers.get(trigger.id)
      if (registration) {
        registration.status = 'error'
        registration.lastError = `Invalid cron expression "${trigger.schedule}": ${(err as Error).message}`
        registration.lastErrorAt = Date.now()
        registration.lastOutcome = 'failed'
      }
      console.error(`Trigger ${trigger.id} disabled: invalid cron "${trigger.schedule}"`)
      return
    }
    const registration = this.triggers.get(trigger.id)
    if (registration) registration.nextRunAt = Date.now() + delay
    const handle = setTimeout(() => {
      const reg = this.triggers.get(trigger.id)
      if (!reg || reg.status !== 'active' || !trigger.enabled) return
      // Reschedule the next firing first so a slow run doesn't drift the schedule.
      this.scheduleNextCron(trigger)
      this.fire(trigger)
    }, delay)
    handle.unref?.()
    this.cronJobs.set(trigger.id, handle)
  }

  private stopCronTrigger(triggerId: string): void {
    const job = this.cronJobs.get(triggerId)
    if (job) {
      clearTimeout(job)
      this.cronJobs.delete(triggerId)
    }
  }

  private startIntervalTrigger(trigger: IntervalTrigger): void {
    this.stopIntervalTrigger(trigger.id)
    const registration = this.triggers.get(trigger.id)
    if (
      !Number.isFinite(trigger.intervalMs) ||
      trigger.intervalMs < 1 ||
      trigger.intervalMs > MAX_INTERVAL_MS
    ) {
      if (registration) {
        registration.status = 'error'
        registration.lastError = `Invalid interval ${trigger.intervalMs}: must be 1..${MAX_INTERVAL_MS}ms`
        registration.lastErrorAt = Date.now()
        registration.lastOutcome = 'failed'
      }
      return
    }
    const fireIfActive = () => {
      if (trigger.enabled && this.triggers.get(trigger.id)?.status === 'active') {
        if (registration) registration.nextRunAt = Date.now() + trigger.intervalMs
        this.fire(trigger)
      }
    }
    const startInterval = () => {
      const interval = setInterval(fireIfActive, trigger.intervalMs)
      interval.unref?.()
      this.intervalJobs.set(trigger.id, interval)
    }
    if (trigger.initialDelayMs !== undefined) {
      if (registration) registration.nextRunAt = Date.now() + trigger.initialDelayMs
      const initial = setTimeout(() => {
        fireIfActive()
        startInterval()
      }, trigger.initialDelayMs)
      initial.unref?.()
      this.intervalJobs.set(trigger.id, initial)
      return
    }

    const job = setInterval(fireIfActive, trigger.intervalMs)
    if (registration) registration.nextRunAt = Date.now() + trigger.intervalMs
    job.unref?.()

    this.intervalJobs.set(trigger.id, job)
  }

  private stopIntervalTrigger(triggerId: string): void {
    const job = this.intervalJobs.get(triggerId)
    if (job) {
      clearInterval(job)
      this.intervalJobs.delete(triggerId)
    }
  }

  /**
   * Apply the overlap policy and schedule the execution.
   * - fail-fast: skip if a previous run is in progress.
   * - wait: chain after the previous run (next() resolves before we start).
   * - run-concurrent: start immediately regardless.
   */
  fire(triggerOrId: Trigger | string): void {
    const trigger =
      typeof triggerOrId === 'string' ? this.triggers.get(triggerOrId)?.trigger : triggerOrId
    if (trigger === undefined) return
    const previous = this.lastRun.get(trigger.id)
    const running = this.runningCount.get(trigger.id) ?? 0
    const isRunning = running > 0
    const policy = trigger.overlap ?? 'wait'
    const maxConcurrent = trigger.maxConcurrent ?? Number.POSITIVE_INFINITY

    if (running >= maxConcurrent) {
      const registration = this.triggers.get(trigger.id)
      if (registration) registration.lastOutcome = 'skipped'
      return
    }

    if (isRunning && policy === 'fail-fast') {
      const registration = this.triggers.get(trigger.id)
      if (registration) registration.lastOutcome = 'skipped'
      return
    }

    const start = isRunning && policy === 'wait' && previous ? previous : Promise.resolve()

    this.reserveExecution(trigger.id)
    const promise = start
      .then(() => this.executeTrigger(trigger))
      .finally(() => this.releaseExecution(trigger.id))
    this.lastRun.set(trigger.id, promise)
    const registration = this.triggers.get(trigger.id)
    if (registration) registration.lastOutcome = 'dispatched'
    this.track(promise)
  }

  private reserveExecution(triggerId: string): void {
    const n = (this.runningCount.get(triggerId) ?? 0) + 1
    this.runningCount.set(triggerId, n)
    const registration = this.triggers.get(triggerId)
    if (registration) registration.runningCount = n
  }

  private releaseExecution(triggerId: string): void {
    const n = (this.runningCount.get(triggerId) ?? 1) - 1
    if (n <= 0) {
      this.runningCount.delete(triggerId)
    } else {
      this.runningCount.set(triggerId, n)
    }
    const registration = this.triggers.get(triggerId)
    if (registration) registration.runningCount = this.runningCount.get(triggerId) ?? 0
  }

  private async executeTrigger(trigger: Trigger): Promise<void> {
    const registration = this.triggers.get(trigger.id)
    if (!registration) return

    try {
      const ctx: TriggerContext = {
        triggerId: trigger.id,
        runId: `trigger-${trigger.id}-${Date.now()}`,
        scheduledAt: Date.now(),
        actualAt: Date.now(),
        deduped: false,
        overlapHandled: false,
      }

      if (this.pipelineExecutor === undefined) {
        // No executor wired: register the fire but do NOT persist a
        // status='running' Run. Persisting one without anything to
        // finalize it leaves an orphan that crash-recovery cannot
        // distinguish from a real interrupted run. Production callers
        // wire pipelineExecutor (typically the gateway TriggerCoordinator,
        // not this class). Warn once per trigger so the misconfig is loud.
        if (!this.noExecutorWarned.has(trigger.id)) {
          this.noExecutorWarned.add(trigger.id)
          console.warn(
            `Scheduler: trigger ${trigger.id} fired but no pipelineExecutor is configured; Run will not be persisted. Wire deps.pipelineExecutor to execute pipelines.`,
          )
        }
        registration.runCount++
        registration.lastRunAt = Date.now()
        registration.status = 'active'
        registration.lastOutcome = 'succeeded'
      } else {
        const pipeline = await this.pipelineLoader(trigger.pipelineId)
        if (!pipeline) {
          throw new Error(`Pipeline ${trigger.pipelineId} not found`)
        }
        const input = trigger.inputTemplate ?? {}
        const run: Run = await this.pipelineExecutor(pipeline, input, ctx)
        await this.runStore.putRun(run)
        registration.runCount++
        registration.lastRunAt = Date.now()
        registration.status = run.status === 'failed' ? 'error' : 'active'
        registration.lastOutcome = run.status === 'failed' ? 'failed' : 'succeeded'
        if (run.error?.message) {
          registration.lastError = run.error.message
          registration.lastErrorAt = Date.now()
        }
      }
    } catch (err) {
      registration.errorCount++
      registration.status = 'error'
      registration.lastError = (err as Error).message
      registration.lastErrorAt = Date.now()
      registration.lastOutcome = 'failed'
      console.error(`Trigger ${trigger.id} error:`, err)
    }
  }
}

function extractLegacyDeps(config: SchedulerConfig | LegacySchedulerConfig): SchedulerDeps {
  const maybe = config as Partial<LegacySchedulerConfig>
  if (maybe.runStore === undefined) {
    throw new TypeError('Scheduler requires deps.runStore')
  }
  return {
    runStore: maybe.runStore,
    ...(maybe.pipelineLoader !== undefined && { pipelineLoader: maybe.pipelineLoader }),
    ...(maybe.pipelineExecutor !== undefined && { pipelineExecutor: maybe.pipelineExecutor }),
  }
}

function normalizeTrigger(trigger: Trigger | LegacyTrigger): Trigger {
  if ('type' in trigger) return trigger
  const base = {
    id: trigger.id,
    pipelineId: trigger.workflowId,
    enabled: trigger.enabled ?? true,
    ...(trigger.description !== undefined && { description: trigger.description }),
    ...(trigger.dedupe !== undefined && { dedupe: trigger.dedupe }),
    ...(trigger.overlap !== undefined && { overlap: trigger.overlap }),
    ...(trigger.maxConcurrent !== undefined && { maxConcurrent: trigger.maxConcurrent }),
    ...(trigger.inputTemplate !== undefined && { inputTemplate: trigger.inputTemplate }),
    ...(trigger.metadata !== undefined && { metadata: trigger.metadata }),
  }
  switch (trigger.kind) {
    case 'cron':
      return {
        ...base,
        type: 'cron',
        schedule: trigger.schedule ?? trigger.cron ?? '',
        ...(trigger.timezone !== undefined && { timezone: trigger.timezone }),
      }
    case 'interval':
      return {
        ...base,
        type: 'interval',
        intervalMs: trigger.intervalMs ?? 0,
        ...(trigger.initialDelayMs !== undefined && { initialDelayMs: trigger.initialDelayMs }),
      }
    case 'webhook':
      return {
        ...base,
        type: 'webhook',
        path: trigger.path ?? `/${trigger.id}`,
        ...(trigger.secret !== undefined && { secret: trigger.secret }),
        ...(trigger.transformPayload !== undefined && {
          transformPayload: trigger.transformPayload,
        }),
      }
  }
}
