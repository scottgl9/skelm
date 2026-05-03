/**
 * Cron trigger implementation
 * 
 * Executes workflows on a scheduled basis using cron expressions
 */

import { TriggerPluginBase } from './base.js'
import type { TriggerConfig, TriggerType, TriggerEvent, TriggerHealthStatus } from './types.js'

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

/**
 * Simple cron parser (supports basic expressions)
 * Format: minute hour day-of-month month day-of-week
 */
function parseCronExpression(expression: string): {
  minutes: number[]
  hours: number[]
  days: number[]
  months: number[]
  dayOfWeeks: number[]
} {
  const parts = expression.split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${expression}. Expected 5 parts`)
  }
  
  const [minute, hour, day, month, dayOfWeek] = parts
  
  // Simple parser - supports *, numbers, and ranges (e.g., 1-5)
  const parseField = (field: string, min: number, max: number): number[] => {
    if (field === '*') {
      return Array.from({ length: max - min + 1 }, (_, i) => min + i)
    }
    
    if (field.includes('-')) {
      const parts = field.split('-')
      const start = Number(parts[0])
      const end = Number(parts[1])
      return Array.from({ length: end - start + 1 }, (_, i) => start + i)
    }
    
    return [Number(field)]
  }
  
  return {
    minutes: parseField(minute!, 0, 59),
    hours: parseField(hour!, 0, 23),
    days: parseField(day!, 1, 31),
    months: parseField(month!, 1, 12),
    dayOfWeeks: parseField(dayOfWeek!, 0, 6),
  }
}

/**
 * Calculate next run time from cron expression
 */
function getNextRunTime(schedule: string, from: Date = new Date()): Date {
  const parsed = parseCronExpression(schedule)
  const next = new Date(from)
  
  // Move to next minute
  next.setSeconds(0)
  next.setMilliseconds(0)
  next.setMinutes(next.getMinutes() + 1)
  
  // Find next matching time (search up to 1 year ahead)
  const maxIterations = 366 * 24 * 60 // 1 year in minutes
  let iterations = 0
  
  while (iterations < maxIterations) {
    const matches =
      parsed.minutes.includes(next.getMinutes()) &&
      parsed.hours.includes(next.getHours()) &&
      parsed.days.includes(next.getDate()) &&
      parsed.months.includes(next.getMonth() + 1) &&
      parsed.dayOfWeeks.includes(next.getDay())
    
    if (matches) {
      return next
    }
    
    next.setMinutes(next.getMinutes() + 1)
    iterations++
  }
  
  throw new Error('Could not find next run time within 1 year')
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
    try {
      parseCronExpression(config.schedule)
    } catch (error) {
      throw new Error(`Invalid cron schedule: ${error instanceof Error ? error.message : String(error)}`)
    }
    
    // Call parent initialize first to set up base config
    await super.initialize(config)
    
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
    const nextRun = getNextRunTime(config.schedule)
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
