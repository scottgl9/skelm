/**
 * @skelm/scheduler - Long-running trigger management for pipelines
 * 
 * Supports: cron, interval, webhook, poll, queue triggers
 * with dedupe and overlap policies.
 */

import type { RunId } from '@skelm/core'

/** Trigger types */
export type TriggerType = 'cron' | 'interval' | 'webhook' | 'poll' | 'queue'

/** Trigger deduplication strategies */
export type DedupePolicy = 'skip' | 'overwrite' | 'queue'

/** Trigger overlap strategies */
export type OverlapPolicy = 'wait' | 'fail-fast' | 'run-concurrent'

/** Base trigger configuration */
export interface TriggerBase {
  id: string
  type: TriggerType
  pipelineId: string
  description?: string
  enabled: boolean
  dedupe?: DedupePolicy
  overlap?: OverlapPolicy
  maxConcurrent?: number
  inputTemplate?: unknown
  metadata?: Record<string, unknown>
}

/** Cron trigger - schedule based on cron expression */
export interface CronTrigger extends TriggerBase {
  type: 'cron'
  schedule: string // Cron expression (e.g., '0 * * * *' for hourly)
  timezone?: string
}

/** Interval trigger - run at fixed intervals */
export interface IntervalTrigger extends TriggerBase {
  type: 'interval'
  intervalMs: number
  initialDelayMs?: number
}

/** Webhook trigger - external HTTP callback */
export interface WebhookTrigger extends TriggerBase {
  type: 'webhook'
  path: string // URL path for webhook endpoint
  secret?: string // Optional secret for signature verification
  transformPayload?: (payload: unknown) => unknown
}

/** Poll trigger - check external source periodically */
export interface PollTrigger extends TriggerBase {
  type: 'poll'
  url: string
  intervalMs: number
  headers?: Record<string, string>
  detectNew?: (previous: unknown, current: unknown) => boolean
  extractInput?: (data: unknown) => unknown | null
}

/** Queue trigger - message queue based */
export interface QueueTrigger extends TriggerBase {
  type: 'queue'
  queueName: string
  batchSize?: number
  visibilityTimeoutMs?: number
  extractInput?: (message: unknown) => unknown | null
}

export type Trigger = CronTrigger | IntervalTrigger | WebhookTrigger | PollTrigger | QueueTrigger

/** Trigger registration */
export interface TriggerRegistration {
  trigger: Trigger
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  nextRunAt?: number
  runCount: number
  errorCount: number
  status: 'active' | 'paused' | 'error'
  lastError?: string
}

/** Trigger execution context */
export interface TriggerContext {
  triggerId: string
  runId: string
  scheduledAt: number
  actualAt: number
  deduped: boolean
  overlapHandled: boolean
}

/** Scheduler configuration */
export interface SchedulerConfig {
  dbPath?: string
  webhookPort?: number
  webhookHost?: string
  pollConcurrency?: number
  queuePollIntervalMs?: number
}
