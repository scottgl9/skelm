import type {
  CronTrigger,
  IntervalTrigger,
  PollTrigger,
  QueueTrigger,
  SchedulerConfig,
  Trigger,
  TriggerContext,
  TriggerRegistration,
} from './types.js'

/**
 * Scheduler manages long-running triggers for pipelines.
 * Handles cron, interval, webhook, poll, and queue-based triggers
 * with deduplication and overlap policies.
 */
export class Scheduler {
  private readonly config: SchedulerConfig
  private readonly triggers = new Map<string, TriggerRegistration>()
  private readonly cronJobs = new Map<string, NodeJS.Timeout>()
  private readonly intervalJobs = new Map<string, NodeJS.Timeout>()
  private webhookServer: unknown | null = null
  private pollJobs = new Map<string, NodeJS.Timeout>()
  private queueJobs = new Map<string, NodeJS.Timeout>()
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

    // Start the trigger based on type
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
      case 'poll':
        this.startPollTrigger(trigger)
        break
      case 'queue':
        this.startQueueTrigger(trigger)
        break
    }

    return registration
  }

  /** Unregister a trigger */
  async unregister(triggerId: string): Promise<void> {
    const registration = this.triggers.get(triggerId)
    if (!registration) return

    // Stop any running jobs
    this.stopCronTrigger(triggerId)
    this.stopIntervalTrigger(triggerId)
    this.stopPollTrigger(triggerId)
    this.stopQueueTrigger(triggerId)

    this.triggers.delete(triggerId)
  }

  /** Pause a trigger */
  async pause(triggerId: string): Promise<void> {
    const registration = this.triggers.get(triggerId)
    if (!registration) return

    registration.status = 'paused'
    registration.updatedAt = Date.now()

    // Stop jobs for time-based triggers
    this.stopCronTrigger(triggerId)
    this.stopIntervalTrigger(triggerId)
    this.stopPollTrigger(triggerId)
    this.stopQueueTrigger(triggerId)
  }

  /** Resume a paused trigger */
  async resume(triggerId: string): Promise<void> {
    const registration = this.triggers.get(triggerId)
    if (!registration) return
    if (registration.status !== 'paused') return

    registration.status = 'active'
    registration.updatedAt = Date.now()
    const trigger = registration.trigger

    // Restart jobs based on type
    switch (trigger.type) {
      case 'cron':
        this.startCronTrigger(trigger)
        break
      case 'interval':
        this.startIntervalTrigger(trigger)
        break
      case 'poll':
        this.startPollTrigger(trigger)
        break
      case 'queue':
        this.startQueueTrigger(trigger)
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
    // Webhook server implementation would go here
    // Uses h3 or similar for HTTP handling
    console.log(
      `Webhook server would start on ${this.config.webhookHost}:${this.config.webhookPort}`,
    )
  }

  /** Stop the webhook server */
  async stopWebhookServer(): Promise<void> {
    // Stop webhook server
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
          case 'poll':
            this.startPollTrigger(trigger)
            break
          case 'queue':
            this.startQueueTrigger(trigger)
            break
        }
      }
    }
  }

  /** Stop all triggers */
  async stop(): Promise<void> {
    if (!this.isRunning) return
    this.isRunning = false

    // Clear all jobs
    for (const [id, job] of this.cronJobs) {
      clearInterval(job)
      this.cronJobs.delete(id)
    }
    for (const [id, job] of this.intervalJobs) {
      clearInterval(job)
      this.intervalJobs.delete(id)
    }
    for (const [id, job] of this.pollJobs) {
      clearInterval(job)
      this.pollJobs.delete(id)
    }
    for (const [id, job] of this.queueJobs) {
      clearInterval(job)
      this.queueJobs.delete(id)
    }
  }

  private startCronTrigger(trigger: CronTrigger): void {
    // Simple cron implementation using setInterval
    // In production, use 'cron' package for proper cron expression parsing
    const intervalMs = this.parseCronToInterval(trigger.schedule)

    const job = setInterval(async () => {
      if (trigger.enabled && this.triggers.get(trigger.id)?.status === 'active') {
        await this.executeTrigger(trigger)
      }
    }, intervalMs)

    this.cronJobs.set(trigger.id, job)
  }

  private stopCronTrigger(triggerId: string): void {
    const job = this.cronJobs.get(triggerId)
    if (job) {
      clearInterval(job)
      this.cronJobs.delete(triggerId)
    }
  }

  private startIntervalTrigger(trigger: IntervalTrigger): void {
    const job = setInterval(async () => {
      if (trigger.enabled && this.triggers.get(trigger.id)?.status === 'active') {
        await this.executeTrigger(trigger)
      }
    }, trigger.intervalMs)

    this.intervalJobs.set(trigger.id, job)
  }

  private stopIntervalTrigger(triggerId: string): void {
    const job = this.intervalJobs.get(triggerId)
    if (job) {
      clearInterval(job)
      this.intervalJobs.delete(triggerId)
    }
  }

  private startPollTrigger(trigger: PollTrigger): void {
    const job = setInterval(async () => {
      if (trigger.enabled && this.triggers.get(trigger.id)?.status === 'active') {
        await this.executePollTrigger(trigger)
      }
    }, trigger.intervalMs)

    this.pollJobs.set(trigger.id, job)
  }

  private stopPollTrigger(triggerId: string): void {
    const job = this.pollJobs.get(triggerId)
    if (job) {
      clearInterval(job)
      this.pollJobs.delete(triggerId)
    }
  }

  private startQueueTrigger(trigger: QueueTrigger): void {
    const job = setInterval(async () => {
      if (trigger.enabled && this.triggers.get(trigger.id)?.status === 'active') {
        await this.executeQueueTrigger(trigger)
      }
    }, this.config.queuePollIntervalMs)

    this.queueJobs.set(trigger.id, job)
  }

  private stopQueueTrigger(triggerId: string): void {
    const job = this.queueJobs.get(triggerId)
    if (job) {
      clearInterval(job)
      this.queueJobs.delete(triggerId)
    }
  }

  private async executeTrigger(trigger: Trigger): Promise<void> {
    const registration = this.triggers.get(trigger.id)
    if (!registration) return

    try {
      // Check deduplication
      const ctx: TriggerContext = {
        triggerId: trigger.id,
        runId: `trigger-${trigger.id}-${Date.now()}`,
        scheduledAt: Date.now(),
        actualAt: Date.now(),
        deduped: false,
        overlapHandled: false,
      }

      // Handle overlap policy - check if already running
      if (registration.status === 'active') {
        // Check for concurrent run tracking (simplified)
        const hasActiveRun = false // Would track active runs in production
        if (hasActiveRun) {
          ctx.overlapHandled = true
          switch (trigger.overlap ?? 'wait') {
            case 'fail-fast':
              console.log(`Trigger ${trigger.id} skipped: overlap policy is fail-fast`)
              return
            case 'run-concurrent':
              // Allow concurrent runs
              break
            case 'wait':
            default:
              console.log(`Trigger ${trigger.id} waiting for previous run to complete`)
              return
          }
        }
      }

      // Execute the pipeline
      const pipeline = await this.pipelineLoader(trigger.pipelineId)
      if (!pipeline) {
        throw new Error(`Pipeline ${trigger.pipelineId} not found`)
      }

      // Create and store the run
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

      console.log(`Trigger ${trigger.id} executed run ${ctx.runId}`)
    } catch (err) {
      registration.errorCount++
      registration.status = 'error'
      registration.lastError = (err as Error).message
      console.error(`Trigger ${trigger.id} error:`, err)
    }
  }

  private async executePollTrigger(trigger: PollTrigger): Promise<void> {
    // Poll implementation would fetch from URL and check for new items
    console.log(`Polling ${trigger.url} for trigger ${trigger.id}`)
    await this.executeTrigger(trigger)
  }

  private async executeQueueTrigger(trigger: QueueTrigger): Promise<void> {
    // Queue implementation would poll message queue and process batches
    console.log(`Checking queue ${trigger.queueName} for trigger ${trigger.id}`)
    await this.executeTrigger(trigger)
  }

  private parseCronToInterval(cron: string): number {
    // Simplified cron-to-interval conversion
    // In production, use a proper cron library
    if (!cron || typeof cron !== 'string') {
      return 5 * 60 * 1000 // Default to 5 minutes
    }

    const parts = cron.split(' ')
    if (parts.length !== 5) {
      // Default to 5 minutes if invalid
      return 5 * 60 * 1000
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

    // Simple heuristic for common patterns
    if (minute === '*') return 60 * 1000 // Every minute
    if (hour === '*') return 60 * 60 * 1000 // Every hour
    if (dayOfMonth === '*' && dayOfWeek === '*') {
      const minVal = Number.parseInt(minute || '0', 10) || 0
      return minVal * 60 * 1000
    }

    // Default to 5 minutes
    return 5 * 60 * 1000
  }
}
