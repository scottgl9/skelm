/** Minimal trigger surface the gateway coordinator drives. */

export type TriggerSpec =
  | { kind: 'cron'; id: string; workflowId: string; cron: string }
  | { kind: 'interval'; id: string; workflowId: string; everyMs: number }
  | { kind: 'manual'; id: string; workflowId: string }

export type OverlapPolicy = 'skip' | 'queue' | 'cancel'

export interface TriggerRegistration {
  spec: TriggerSpec
  overlap: OverlapPolicy
  /** Number of times the trigger has fired (excluding skipped overlaps). */
  fired: number
  /** Whether a run is currently in flight for this trigger. */
  inflight: boolean
  /** Last fire timestamp (ISO-8601). */
  lastFiredAt?: string
  /** Last error from the run callback, if any. */
  lastError?: string
}

export interface FireContext {
  triggerId: string
  workflowId: string
  firedAt: string
}

export type RunCallback = (ctx: FireContext) => Promise<void>
