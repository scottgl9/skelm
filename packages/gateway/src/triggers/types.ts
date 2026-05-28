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
      /** Provider hint — see `PipelineTrigger` for protocol semantics. */
      provider?: 'slack' | 'ms-graph'
      /**
       * For `provider: 'ms-graph'`: the shared `clientState` value the Graph
       * subscription was created with. Every notification carries this back;
       * the gateway rejects POSTs whose embedded `clientState` doesn't match.
       * Required to authenticate the sender (Graph does not sign payloads).
       */
      clientState?: string
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
      kind: 'event-source'
      id: string
      workflowId: string
      source: 'websocket' | 'sse' | 'rss' | 'custom'
      options: {
        url?: string
        feedUrl?: string
        pollIntervalMs?: number
        reconnect?: boolean
        reconnectDelayMs?: number
        maxReconnectAttempts?: number
        initialItems?: number
        start?: (fire: (payload: unknown) => void, signal: AbortSignal) => void | Promise<void>
      }
      filter?: Record<string, unknown>
    }
  | {
      kind: 'file-watch'
      id: string
      workflowId: string
      path: string
      events?: readonly ('create' | 'update' | 'delete')[]
      debounceMs?: number
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
  /**
   * Maximum number of queued fires when `overlap: 'queue'`. Defaults to the
   * coordinator's `defaultMaxQueueDepth` (1000). Fires arriving past the cap
   * are dropped and counted in `dropped`. Has no effect for other overlaps.
   */
  maxQueueDepth?: number
  /** Number of fires dropped because the per-trigger queue was full. */
  dropped: number
  /**
   * True when this registration came from a pipeline's declared
   * `triggers:` array (vs `POST /schedules`). Used by the reload sweep to
   * distinguish operator-managed schedules from declared ones, since
   * inferring provenance from the id format would silently delete an
   * operator schedule whose id happens to share a `#` separator.
   */
  declared?: boolean
  /**
   * When true, `fire()` bypasses the per-trigger inflight gate (and the
   * overlap policy that depends on it) so concurrent fires dispatch in
   * parallel rather than being serialized or skipped.
   *
   * This is the right behaviour for triggers whose target multiplexes
   * across independent sub-resources — most notably a `persistentAgent`
   * trigger, where two fires with different `sessionKey`s are two
   * independent durable sessions that should be allowed to run at the
   * same time. Same-session ordering is preserved by
   * `runPersistentTurn`'s own per-(workflowId, sessionKey) lock, not by
   * the trigger-level inflight gate.
   *
   * Flipped to true lazily by the dispatcher the first time it loads the
   * workflow and discovers it is a persistent agent. Plain pipeline
   * triggers remain serial (default false) so `overlap: 'skip' | 'queue'`
   * keep their previous semantics.
   */
  parallel?: boolean
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
