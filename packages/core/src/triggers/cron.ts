/**
 * Cron trigger implementation
 *
 * Executes workflows on a scheduled basis using cron expressions
 */

import { nextCronFireTime, parseCronExpression } from '../cron-expression.js'
import { TriggerPluginBase } from './base.js'
import type { TriggerConfig, TriggerEvent, TriggerHealthStatus, TriggerType } from './types.js'

/**
 * Cron trigger configuration
 */
export interface CronTriggerConfig extends TriggerConfig {
  /** Cron expression (e.g., "0 0 * * *" for midnight daily) */
  schedule: string
  /** Timezone for the schedule (default: system timezone) */
  timezone?: string
  /** Optional workflow ID to invoke */
  workflowId?: string
  /** Optional input data to pass to the workflow */
  input?: unknown
}

/**
 * Cron job entry
 */
interface CronJob {
  timeoutId: NodeJS.Timeout | null
  nextRun: Date | null
}

function getNextRunTime(schedule: string, timezone?: string, from: Date = new Date()): Date {
  const parsed = parseCronExpression(schedule, timezone)
  if (parsed === null) {
    throw new Error(`Invalid cron expression: ${schedule}. Expected 5 parts`)
  }
  const next = nextCronFireTime(parsed, from)
  if (next === null) throw new Error('Could not find next run time within 1 year')
  return next
}

/**
 * Cron trigger plugin
 */
export class CronTrigger extends TriggerPluginBase {
  private job: CronJob = { timeoutId: null, nextRun: null }

  constructor(id: string, name: string, description?: string) {
    super(id, name, '1.0.0', description)
  }

  override getTriggerType(): TriggerType {
    return 'cron'
  }

  override async doInitialize(config: CronTriggerConfig): Promise<void> {
    // Validate schedule
    if (
      typeof config.schedule !== 'string' ||
      parseCronExpression(config.schedule, config.timezone) === null
    ) {
      throw new Error(`Invalid cron schedule: Invalid cron expression: ${config.schedule}`)
    }

    this.logger.info(`Initialized cron trigger with schedule: ${config.schedule}`)
  }

  override async doStart(): Promise<void> {
    const config = this.config as CronTriggerConfig | null
    if (!config) {
      throw new Error('Cron trigger not initialized')
    }

    // Schedule the first run
    await this.scheduleNextRun()

    this.logger.info(`Cron trigger started, next run: ${this.job.nextRun?.toISOString()}`)
  }

  override async doStop(): Promise<void> {
    if (this.job.timeoutId) {
      clearTimeout(this.job.timeoutId)
      this.job.timeoutId = null
    }

    this.job.nextRun = null
    this.logger.info('Cron trigger stopped')
  }

  override async doHealthCheck(): Promise<TriggerHealthStatus> {
    const config = this.config as CronTriggerConfig | null
    return {
      healthy: true,
      status: 'healthy',
      details: {
        nextRun: this.job.nextRun?.toISOString(),
        schedule: config?.schedule,
      },
    }
  }

  /**
   * Schedule the next run
   */
  private async scheduleNextRun(): Promise<void> {
    const config = this.config as CronTriggerConfig | null
    if (!config) {
      return
    }

    // Calculate next run time
    const nextRun = getNextRunTime(config.schedule, config.timezone)
    this.job.nextRun = nextRun

    // Calculate delay
    const delay = nextRun.getTime() - Date.now()

    this.logger.debug(`Scheduling next run in ${delay}ms (${nextRun.toISOString()})`)

    // Clear existing timeout
    if (this.job.timeoutId) {
      clearTimeout(this.job.timeoutId)
    }

    // Schedule new timeout
    this.job.timeoutId = setTimeout(async () => {
      await this.run()
      await this.scheduleNextRun()
    }, delay)
  }

  /**
   * Execute the trigger
   */
  private async run(): Promise<void> {
    this.logger.info(`Cron trigger executed at ${new Date().toISOString()}`)

    const config = this.config as CronTriggerConfig | null

    // Create event
    const event: TriggerEvent = {
      eventId: `cron-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      triggerId: this.id,
      triggerType: 'cron',
      timestamp: new Date(),
      payload: {
        schedule: config?.schedule,
        nextRun: this.job.nextRun?.toISOString(),
      },
      metadata: {
        source: 'cron',
        ...(config?.workflowId !== undefined && { workflowId: config.workflowId }),
      },
    }

    // Emit event
    await this.emitEvent(event)
  }
}

/**
 * Create a cron trigger
 */
export function createCronTrigger(id: string, name: string, description?: string): CronTrigger {
  return new CronTrigger(id, name, description)
}
