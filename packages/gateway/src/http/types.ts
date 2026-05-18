import type { Pipeline, Run, RunStatus, RunSummary } from '@skelm/core'

/**
 * Server instance managing HTTP + SSE surface
 */
export interface SkelmServer {
  /** Start the server */
  start(): Promise<void>

  /** Stop the server */
  stop(): Promise<void>

  /** Check if server is running */
  isRunning(): boolean

  /** Get server URL */
  getUrl(): string
}

/**
 * Pipeline info for discovery endpoints
 */
export interface PipelineInfo {
  id: string
  description?: string
  version?: string
  tags?: string[]
  file?: string
}

/**
 * Pipeline detail with graph
 */
export interface PipelineDetail extends PipelineInfo {
  input: unknown // JSON Schema
  output: unknown // JSON Schema
  graph: unknown // PipelineGraph serialized
}

/**
 * Run listing response
 */
export interface RunListItem {
  runId: string
  pipelineId: string
  status: RunStatus
  startedAt: number
  completedAt?: number
}

/**
 * Run detail response
 */
export type RunDetail = Run

/**
 * Sync run response
 */
export interface SyncRunResponse {
  runId: string
  status: 'completed' | 'failed' | 'waiting'
  output?: unknown
  error?: {
    message: string
    code?: string
  }
  wait?: {
    stepId: string
    message: string
    schema: unknown
  }
}

/**
 * Async start response
 */
export interface AsyncStartResponse {
  runId: string
  status: 'running'
}

/**
 * Schedule trigger types
 */
export type ScheduleTrigger =
  | { kind: 'immediate' }
  | { kind: 'at'; when: string } // ISO 8601
  | { kind: 'cron'; expression: string; timezone?: string }
  | { kind: 'interval'; everyMs: number; initialDelayMs?: number }
  | {
      kind: 'webhook'
      path: string
      method?: string
      secret?: string
      dedupe?: { header: string; ttlMs?: number }
    }
  | { kind: 'poll'; everyMs: number; sourceFnId: string; dedupeKeyFnId?: string }
  | { kind: 'queue'; driver: string; config: Record<string, unknown> }

/**
 * Schedule overlap policy
 */
export type OverlapPolicy = 'skip' | 'queue' | 'cancel'

/**
 * Schedule retention policy
 */
export type RetentionPolicy = 'persistent' | 'auto-deregister'

/**
 * Schedule registration
 */
export interface Schedule {
  id: string
  workflowId: string
  trigger: ScheduleTrigger
  overlap: OverlapPolicy
  defaultInput?: Record<string, unknown>
  enabled: boolean
  retention: RetentionPolicy
  notes?: string
}

/**
 * Schedule status
 */
export interface ScheduleStatus {
  id: string
  workflowId: string
  status: 'running' | 'paused' | 'disabled' | 'failed'
  trigger: ScheduleTrigger
  overlap: OverlapPolicy
  enabled: boolean
  retention: RetentionPolicy
  lastFireAt?: number
  lastRunId?: string
  lastRunStatus?: RunStatus
  inFlightRuns: number
  stats: {
    fires24h: number
    failures24h: number
    avgDurationMs: number
  }
}
