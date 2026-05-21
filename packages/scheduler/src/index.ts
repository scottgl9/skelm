/**
 * @skelm/scheduler - Long-running trigger management for pipelines
 *
 * Provides cron, interval, webhook, poll, and queue-based triggers
 * with deduplication and overlap policies.
 */

export { Scheduler } from './scheduler.js'
export type {
  SchedulerRunStore,
  SchedulerPipelineLoader,
  SchedulerPipelineExecutor,
} from './scheduler.js'
export {
  createCronTrigger,
  createIntervalTrigger,
  createWebhookTrigger,
} from './builders.js'

export type {
  SchedulerConfig,
  Trigger,
  TriggerRegistration,
  TriggerContext,
  TriggerType,
  DedupePolicy,
  OverlapPolicy,
  TriggerBase,
  CronTrigger,
  IntervalTrigger,
  WebhookTrigger,
} from './types.js'

export type { TriggerOptions } from './builders.js'
