/** Minimal trigger surface the gateway coordinator drives. */

export type TriggerSpec =
  | { kind: 'cron'; id: string; workflowId: string; cron: string; tz?: string }
  | { kind: 'interval'; id: string; workflowId: string; everyMs: number; every?: string }
  | { kind: 'manual'; id: string; workflowId: string }
  | { kind: 'immediate'; id: string; workflowId: string }
  | { kind: 'at'; id: string; workflowId: string; when: string }
  | {
      kind: 'webhook'
      id: string
      workflowId: string
      path: string
      method?: string
      secret?: string
      /**
       * Optional pre-dispatch deduplication. When set, the gateway reads the
       * named request header and skips dispatch if the same value has been
       * seen within `ttlMs` (default 24 hours). A `webhook.deduped` audit
       * event is emitted on hit; the HTTP response is still 200 so the
       * webhook source treats the delivery as accepted.
       */
      dedupe?: { header: string; ttlMs?: number }
    }
  | {
      kind: 'poll'
      id: string
      workflowId: string
      everyMs: number
      sourceFnId: string
      dedupeKeyFnId?: string
    }
  | {
      kind: 'queue'
      id: string
      workflowId: string
      driver: string
      config?: Record<string, unknown>
    }

export type OverlapPolicy = 'skip' | 'queue' | 'cancel'

export interface TriggerRegistration {
  spec: TriggerSpec
  overlap: OverlapPolicy
  /**
   * Default pipeline input for fires that don't supply their own payload
   * (cron, interval, manual, at, immediate, and `skelm schedule fire <id>`).
   * Queue and webhook triggers receive a per-fire payload from the source;
   * those still take precedence — `input` is the fallback, not an override.
   *
   * Stored opaquely as JSON; the runtime hands it to the pipeline as the
   * step input where the pipeline's own input schema validates it.
   */
  input?: unknown
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
  /**
   * Per-fire payload supplied by the source (queue driver, webhook adapter,
   * etc). When set, the dispatcher passes this as the pipeline input instead
   * of the default `{ triggerId, firedAt }` metadata.
   */
  payload?: unknown
}

export type RunCallback = (ctx: FireContext) => Promise<void>
