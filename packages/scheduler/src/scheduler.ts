import parser from 'cron-parser'
import type {
  CronTrigger,
  IntervalTrigger,
  SchedulerConfig,
  Trigger,
  TriggerContext,
  TriggerRegistration,
} from './types.js'

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
  private readonly runStore: { putRun: (run: unknown) => Promise<void> }
  private readonly pipelineLoader: (pipelineId: string) => Promise<unknown>

  constructor(
    config: SchedulerConfig,
    deps: {
      runStore: { putRun: (run: unknown) => Promise<void> }
      pipelineLoader: (pipelineId: string) => Promise<unknown>
    },
  ) {
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
    this.runStore = deps.runStore
    this.pipelineLoader = deps.pipelineLoader
  }

  /** Register a new trigger */
  async register(trigger: Trigger): Promise<TriggerRegistration> {
    const registration: TriggerRegistration = {
      trigger,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runCount: 0,
      errorCount: 0,
      status: 'active',
    }

    this.triggers.set(trigger.id, registration)

    switch (trigger.type) {
      case 'cron':
        this.startCronTrigger(trigger)
        break
      case 'interval':
        this.startIntervalTrigger(trigger)
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
      }
      console.error(`Trigger ${trigger.id} disabled: invalid cron "${trigger.schedule}"`)
      return
    }
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
    const job = setInterval(() => {
      if (trigger.enabled && this.triggers.get(trigger.id)?.status === 'active') {
        this.fire(trigger)
      }
    }, trigger.intervalMs)
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
  private fire(trigger: Trigger): void {
    const previous = this.lastRun.get(trigger.id)
    const isRunning = (this.runningCount.get(trigger.id) ?? 0) > 0
    const policy = trigger.overlap ?? 'wait'

    if (isRunning && policy === 'fail-fast') return

    const start = isRunning && policy === 'wait' && previous ? previous : Promise.resolve()

    const promise = start.then(() => this.executeTrigger(trigger))
    this.lastRun.set(trigger.id, promise)
    this.track(promise)
  }

  private async executeTrigger(trigger: Trigger): Promise<void> {
    const registration = this.triggers.get(trigger.id)
    if (!registration) return

    this.runningCount.set(trigger.id, (this.runningCount.get(trigger.id) ?? 0) + 1)
    try {
      const ctx: TriggerContext = {
        triggerId: trigger.id,
        runId: `trigger-${trigger.id}-${Date.now()}`,
        scheduledAt: Date.now(),
        actualAt: Date.now(),
        deduped: false,
        overlapHandled: false,
      }

      const pipeline = await this.pipelineLoader(trigger.pipelineId)
      if (!pipeline) {
        throw new Error(`Pipeline ${trigger.pipelineId} not found`)
      }

      const run = {
        runId: ctx.runId,
        pipelineId: trigger.pipelineId,
        input: trigger.inputTemplate ?? {},
        status: 'running' as const,
        steps: {},
        output: undefined,
        error: undefined,
        startedAt: Date.now(),
        completedAt: undefined,
      }

      await this.runStore.putRun(run)
      registration.runCount++
      registration.lastRunAt = Date.now()
      registration.status = 'active'
    } catch (err) {
      registration.errorCount++
      registration.status = 'error'
      registration.lastError = (err as Error).message
      console.error(`Trigger ${trigger.id} error:`, err)
    } finally {
      const n = (this.runningCount.get(trigger.id) ?? 1) - 1
      if (n <= 0) {
        this.runningCount.delete(trigger.id)
      } else {
        this.runningCount.set(trigger.id, n)
      }
    }
  }
}
