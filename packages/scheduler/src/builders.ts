import type {
  Trigger,
  CronTrigger,
  IntervalTrigger,
  WebhookTrigger,
  PollTrigger,
  QueueTrigger,
  DedupePolicy,
  OverlapPolicy,
} from './types.js'

/** Generate a unique ID for a trigger */
function generateId(): string {
  return `trigger-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

/** Base trigger options */
export interface TriggerOptions {
  description?: string
  enabled?: boolean
  dedupe?: DedupePolicy
  overlap?: OverlapPolicy
  maxConcurrent?: number
  inputTemplate?: unknown
  metadata?: Record<string, unknown>
}

/** Create a cron-based trigger */
export function createCronTrigger(
  id: string,
  pipelineId: string,
  schedule: string,
  options: TriggerOptions = {},
): CronTrigger {
  const result: CronTrigger = {
    id,
    type: 'cron',
    schedule,
    pipelineId,
    enabled: options.enabled ?? true,
    dedupe: options.dedupe ?? 'skip',
    overlap: options.overlap ?? 'wait',
  }

  if (options.description !== undefined) {
    result.description = options.description
  }
  if (options.maxConcurrent !== undefined) {
    result.maxConcurrent = options.maxConcurrent
  }
  if (options.inputTemplate !== undefined) {
    result.inputTemplate = options.inputTemplate
  }
  if (options.metadata !== undefined) {
    result.metadata = options.metadata
    if (options.metadata.timezone !== undefined) {
      result.timezone = options.metadata.timezone as string
    }
  }

  return result
}

/** Create an interval-based trigger */
export function createIntervalTrigger(
  id: string,
  pipelineId: string,
  intervalMs: number,
  options: TriggerOptions & { initialDelayMs?: number } = {},
): IntervalTrigger {
  const result: IntervalTrigger = {
    id,
    type: 'interval',
    intervalMs,
    pipelineId,
    enabled: options.enabled ?? true,
    dedupe: options.dedupe ?? 'skip',
    overlap: options.overlap ?? 'wait',
  }

  if (options.description !== undefined) {
    result.description = options.description
  }
  if (options.initialDelayMs !== undefined) {
    result.initialDelayMs = options.initialDelayMs
  }
  if (options.maxConcurrent !== undefined) {
    result.maxConcurrent = options.maxConcurrent
  }
  if (options.inputTemplate !== undefined) {
    result.inputTemplate = options.inputTemplate
  }
  if (options.metadata !== undefined) {
    result.metadata = options.metadata
  }

  return result
}

/** Create a webhook trigger */
export function createWebhookTrigger(
  id: string,
  pipelineId: string,
  path: string,
  options: TriggerOptions & {
    secret?: string
    transformPayload?: (payload: unknown) => unknown
  } = {},
): WebhookTrigger {
  const result: WebhookTrigger = {
    id,
    type: 'webhook',
    path,
    pipelineId,
    enabled: options.enabled ?? true,
    dedupe: options.dedupe ?? 'skip',
    overlap: options.overlap ?? 'run-concurrent',
    maxConcurrent: options.maxConcurrent ?? 10,
  }

  if (options.description !== undefined) {
    result.description = options.description
  }
  if (options.secret !== undefined) {
    result.secret = options.secret
  }
  if (options.transformPayload !== undefined) {
    result.transformPayload = options.transformPayload
  }
  if (options.inputTemplate !== undefined) {
    result.inputTemplate = options.inputTemplate
  }
  if (options.metadata !== undefined) {
    result.metadata = options.metadata
  }

  return result
}

/** Create a poll trigger */
export function createPollTrigger(
  id: string,
  pipelineId: string,
  url: string,
  intervalMs: number,
  options: TriggerOptions & {
    headers?: Record<string, string>
    detectNew?: (previous: unknown, current: unknown) => boolean
    extractInput?: (data: unknown) => unknown | null
  } = {},
): PollTrigger {
  const result: PollTrigger = {
    id,
    type: 'poll',
    url,
    intervalMs,
    pipelineId,
    enabled: options.enabled ?? true,
    dedupe: options.dedupe ?? 'skip',
    overlap: options.overlap ?? 'wait',
  }

  if (options.description !== undefined) {
    result.description = options.description
  }
  if (options.maxConcurrent !== undefined) {
    result.maxConcurrent = options.maxConcurrent
  }
  if (options.headers !== undefined) {
    result.headers = options.headers
  }
  if (options.detectNew !== undefined) {
    result.detectNew = options.detectNew
  }
  if (options.extractInput !== undefined) {
    result.extractInput = options.extractInput
  }
  if (options.inputTemplate !== undefined) {
    result.inputTemplate = options.inputTemplate
  }
  if (options.metadata !== undefined) {
    result.metadata = options.metadata
  }

  return result
}

/** Create a queue trigger */
export function createQueueTrigger(
  id: string,
  pipelineId: string,
  queueName: string,
  options: TriggerOptions & {
    batchSize?: number
    visibilityTimeoutMs?: number
    extractInput?: (message: unknown) => unknown | null
  } = {},
): QueueTrigger {
  const result: QueueTrigger = {
    id,
    type: 'queue',
    queueName,
    pipelineId,
    enabled: options.enabled ?? true,
    dedupe: options.dedupe ?? 'skip',
    overlap: options.overlap ?? 'run-concurrent',
    maxConcurrent: options.maxConcurrent ?? 5,
    batchSize: options.batchSize ?? 1,
  }

  if (options.description !== undefined) {
    result.description = options.description
  }
  if (options.visibilityTimeoutMs !== undefined) {
    result.visibilityTimeoutMs = options.visibilityTimeoutMs
  }
  if (options.extractInput !== undefined) {
    result.extractInput = options.extractInput
  }
  if (options.inputTemplate !== undefined) {
    result.inputTemplate = options.inputTemplate
  }
  if (options.metadata !== undefined) {
    result.metadata = options.metadata
  }

  return result
}
