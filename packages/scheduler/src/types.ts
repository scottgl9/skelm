/**
 * @skelm/scheduler - Long-running trigger management for pipelines
 *
 * Supports cron, interval, and webhook trigger registration with overlap
 * policies and per-trigger maxConcurrent limits. The dedupe field is reserved
 * for event-keyed trigger sources and is not enforced by this standalone
 * scheduler runtime.
 */

import type { RunId } from '@skelm/core'

/** Trigger types */
export type TriggerType = 'cron' | 'interval' | 'webhook'

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
  /** Reserved for event-keyed trigger sources; not enforced by Scheduler. */
  dedupe?: DedupePolicy
  overlap?: OverlapPolicy
  /** Maximum simultaneous in-flight executions for this trigger. Must be >= 1. */
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

export type Trigger = CronTrigger | IntervalTrigger | WebhookTrigger

/** Trigger registration */
export interface TriggerRegistration {
  trigger: Trigger
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  nextRunAt?: number
  /** Standalone scheduler outcomes intentionally omit gateway queue/cancel states. */
  lastOutcome?: 'dispatched' | 'skipped' | 'succeeded' | 'failed'
  lastErrorAt?: number
  runningCount?: number
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
