import { CRON_LOOKAHEAD_MS, type ParsedCron, nextFireTime, parseCron } from './cron-parser.js'
import { type DedupeStore, InMemoryDedupeStore } from './dedupe-store.js'
import { EventSourceManager } from './event-source-manager.js'
import { FileWatchTrigger } from './file-watcher.js'
import { LongTimer } from './long-timer.js'
import { MAX_INTERVAL_MS, isValidIntervalMs } from './pipeline-trigger-to-spec.js'
import type { QueueDriver } from './queue-driver.js'
import type {
  FireContext,
  OverlapPolicy,
  RunCallback,
  TriggerRegistration,
  TriggerSpec,
} from './types.js'

export interface TriggerCoordinatorOptions {
  /** Dispatcher invoked when a trigger fires. */
  onFire: RunCallback
  /** Default overlap policy. Default: 'skip'. */
  defaultOverlap?: OverlapPolicy
  /** Optional dedupe store backing webhook idempotency. Defaults to InMemoryDedupeStore. */
  webhookDedupe?: DedupeStore
  /**
   * Default cap on queued fires per trigger when `overlap: 'queue'`. Defaults
   * to 1000. Prevents a chatty source plus a slow pipeline from OOMing the
   * gateway. Override per-trigger via `register()` options.
   */
  defaultMaxQueueDepth?: number
  /**
   * Invoked when a fire is dropped because a trigger's queue is full. Default
   * is a no-op; the gateway wires this to a metric / audit writer.
   */
  onQueueDrop?: (triggerId: string, queueDepth: number) => void
  /**
   * Invoked when the onFire dispatcher throws. Without this hook the error
   * is only recorded in `reg.lastError` (the next failure overwrites the
   * previous), so operators never see a continuous error stream. Default
   * is a no-op.
   */
  onFireError?: (triggerId: string, err: unknown) => void
}

const DEFAULT_MAX_QUEUE_DEPTH = 1000

/**
 * Source function for poll triggers. Returns the latest payload (any value)
 * each tick. The coordinator only fires the trigger when the dedupe key
 * differs from the previous tick — by default the dedupe key is a JSON
 * representation of the value, but callers can register an explicit
 * dedupeKeyFn alongside the source for custom equality.
 */
export type PollSourceFn = () => Promise<unknown> | unknown
export type PollDedupeKeyFn = (value: unknown) => string

/**
 * Outcome of `TriggerCoordinator.fire()`. Exposes the overlap-policy decision
 * to HTTP callers so they can map it onto a status code (200 vs 409) instead
 * of always seeing a bare `{ok:true}` (closes F127).
 */
export type FireStatus = 'dispatched' | 'queued' | 'skipped' | 'cancelled' | 'unknown' | 'stopping'

/**
 * Drives the configured triggers and routes fires through `onFire`.
 *
 * Intentionally narrow in Phase 10: cron + interval + manual. The richer
 * trigger surface (matrix, slack, github webhooks) lives in
 * @skelm/core/triggers and plugs into the same coordinator via the
 * `manual` kind plus an external pump.
 */
export class TriggerCoordinator {
  private registrations: Map<string, TriggerRegistration> = new Map()
  private intervalTimers: Map<string, NodeJS.Timeout> = new Map()
  private cronTimers: Map<string, LongTimer> = new Map()
  private fileWatchers: Map<string, FileWatchTrigger> = new Map()
  private eventSourceManagers: Map<string, EventSourceManager> = new Map()
  private atTimers: Map<string, LongTimer> = new Map()
  private pollTimers: Map<string, NodeJS.Timeout> = new Map()
  private webhookRoutes: Map<string, string> = new Map() // path:method → triggerId
  private pollSources: Map<string, PollSourceFn> = new Map()
  private pollDedupeKeyFns: Map<string, PollDedupeKeyFn> = new Map()
  private pollLastKey: Map<string, string> = new Map()
  private queueDrivers: Map<string, QueueDriver> = new Map()
  private queueDriverBindings: Map<string, string> = new Map() // triggerId → driverId
  private queues: Map<string, FireContext[]> = new Map()
  private pendingDispatches: Set<Promise<void>> = new Set()
  private stopping = false
  /**
   * Per-trigger webhook deduplication store. Public so the HTTP dispatch
   * layer (control-routes) can consult it before invoking `fire()`.
   */
  readonly webhookDedupe: DedupeStore

  constructor(private opts: TriggerCoordinatorOptions) {
    this.webhookDedupe = opts.webhookDedupe ?? new InMemoryDedupeStore()
  }

  /**
   * Register a source function that poll triggers reference by `sourceFnId`.
   * Must be called before registering a poll trigger that names this id, or
   * the trigger registers but records lastError.
   */
  registerPollSource(id: string, fn: PollSourceFn, dedupeKeyFn?: PollDedupeKeyFn): void {
    this.pollSources.set(id, fn)
    if (dedupeKeyFn !== undefined) this.pollDedupeKeyFns.set(id, dedupeKeyFn)
  }

  /**
   * Compute the next cron fire and schedule it via setTimeout. The next
   * tick is scheduled BEFORE awaiting the current fire so a long-running
   * pipeline cannot make the cron schedule "walk forward" from
   * completion time — the cron cadence is preserved even when individual
   * fires overrun the period.
   *
   * Stops chaining when the trigger is unregistered or the coordinator
   * is stopping.
   */
  private scheduleNextCron(triggerId: string, parsed: ParsedCron): void {
    if (this.stopping) return
    if (!this.registrations.has(triggerId)) return
    const next = nextFireTime(parsed, new Date())
    if (next === null) {
      // No fire within nextFireTime's lookahead window. This does NOT mean the
      // cron never fires — a valid but sparse expression (e.g. `0 0 29 2 *`,
      // whose next Feb 29 can be years out across a non-leap century) also
      // returns null. The cron was accepted at registration, so silently
      // dropping it here would make it never fire at all. Re-check at the
      // horizon edge instead: each re-check advances `from` by the lookahead,
      // so a far-future fire is eventually found and armed once it comes within
      // range. (A truly impossible expression like Feb 30 simply re-checks
      // harmlessly once per horizon — it fired never before this change too.)
      const recheck = new LongTimer(CRON_LOOKAHEAD_MS, () => {
        this.scheduleNextCron(triggerId, parsed)
      })
      this.cronTimers.set(triggerId, recheck)
      return
    }
    const delay = Math.max(0, next.getTime() - Date.now())
    // A sparse cron (e.g. annual `0 0 1 1 *`) can be months out — a delay
    // well beyond setTimeout's 2^31-1 ms ceiling, where Node would clamp it
    // to 1ms and turn this self-rescheduling timer into a tight loop firing
    // ~1000x/second (DoS). LongTimer arms the delay in safe chunks instead.
    const t = new LongTimer(delay, () => {
      // Schedule the *next* fire before invoking this one so a fire that
      // outlives its period does not skip ticks. The coordinator's
      // overlap policy on the registration decides what happens when a
      // fresh fire arrives while the previous one is still running.
      this.scheduleNextCron(triggerId, parsed)
      this.fireDetached(triggerId, next)
    })
    this.cronTimers.set(triggerId, t)
  }

  /** Returns the trigger id bound to this webhook path+method, if any. */
  resolveWebhook(path: string, method?: string): string | undefined {
    const m = (method ?? 'POST').toUpperCase()
    return this.webhookRoutes.get(`${m} ${path}`)
  }

  /**
   * Register a queue driver under an id. Queue triggers reference the driver
   * by this id via spec.driver. Must be called before registering a queue
   * trigger that names this driver.
   */
  registerQueueDriver(id: string, driver: QueueDriver): void {
    this.queueDrivers.set(id, driver)
  }

  /** Look up a registered queue driver. Used by tests and operators. */
  getQueueDriver(id: string): QueueDriver | undefined {
    return this.queueDrivers.get(id)
  }

  /** Replace the onFire callback after construction. Used by the gateway to */
  /** wire the real workflow dispatcher once registries are loaded. */
  setOnFire(onFire: TriggerCoordinatorOptions['onFire']): void {
    this.opts = { ...this.opts, onFire }
  }

  list(): TriggerRegistration[] {
    return Array.from(this.registrations.values())
  }

  get(id: string): TriggerRegistration | undefined {
    return this.registrations.get(id)
  }

  /**
   * Mark a trigger's fires as parallelisable so they bypass the per-trigger
   * inflight gate (and the overlap policy that depends on it). Called by the
   * dispatcher the first time it discovers the registered workflow is a
   * persistent workflow — those fires multiplex over independent durable
   * sessions and same-session ordering is owned by the per-session lock
   * inside `runPersistentWorkflowTurn`, not by this trigger-level gate.
   *
   * Also clears any in-flight queued backlog and the inflight flag so the
   * currently-draining dispatcher loop stops gating subsequent fires.
   * Idempotent and safe to call from any fire.
   */
  markParallel(id: string): void {
    const reg = this.registrations.get(id)
    if (reg === undefined) return
    if (reg.parallel === true) return
    reg.parallel = true
    // The current dispatch() still holds reg.inflight = true and may have
    // queued items. Hand off the queue: drain it via parallel fires (no
    // gate) and clear inflight so future fire() calls don't wait either.
    const queued = this.queues.get(id)
    if (queued !== undefined && queued.length > 0) {
      this.queues.set(id, [])
      for (const ctx of queued) {
        this.fireDetached(id, undefined, ctx.payload)
      }
    }
    reg.inflight = false
  }

  register(
    spec: TriggerSpec,
    overlap?: OverlapPolicy,
    options: { input?: unknown; declared?: boolean; maxQueueDepth?: number } = {},
  ): TriggerRegistration {
    // Queue triggers default to `overlap: 'queue'` rather than the global
    // `'skip'` default: dropping messages just because the previous fire is
    // still in flight is a silent data-loss bug for queue-fed sources
    // (e.g. an InMemoryQueueDriver burst, a Kafka consumer). Other trigger
    // kinds (cron / interval / webhook) keep the original 'skip' default
    // so a slow pipeline doesn't pile up backlog when caller didn't ask.
    const effectiveOverlap: OverlapPolicy =
      overlap ?? this.opts.defaultOverlap ?? (spec.kind === 'queue' ? 'queue' : 'skip')
    const reg: TriggerRegistration = {
      spec,
      overlap: effectiveOverlap,
      ...(options.input !== undefined && { input: options.input }),
      fired: 0,
      inflight: false,
      dropped: 0,
      ...(options.declared === true && { declared: true }),
      ...(options.maxQueueDepth !== undefined && { maxQueueDepth: options.maxQueueDepth }),
    }
    this.registrations.set(spec.id, reg)
    switch (spec.kind) {
      case 'interval': {
        // Defense in depth: never arm a setInterval with an out-of-range delay
        // (Node clamps <= 0 / > 2^31-1 to 1ms → tight-loop DoS). The spec
        // builders reject these up front; this guards any other path.
        if (!isValidIntervalMs(spec.everyMs)) {
          reg.lastError = `invalid interval everyMs=${spec.everyMs} (must be 1..${MAX_INTERVAL_MS}ms)`
          break
        }
        const t = setInterval(() => {
          this.fireDetached(spec.id)
        }, spec.everyMs)
        t.unref?.()
        this.intervalTimers.set(spec.id, t)
        break
      }
      case 'cron': {
        const parsed = parseCron(spec.cron, spec.tz)
        if (parsed === null) {
          reg.lastError = `unsupported cron expression: ${spec.cron}`
          break
        }
        this.scheduleNextCron(spec.id, parsed)
        break
      }
      case 'immediate':
        // Fire on the next tick so register() can return before dispatch.
        setImmediate(() => {
          this.fireDetached(spec.id)
        }).unref?.()
        break
      case 'at': {
        const ts = Date.parse(spec.when)
        if (Number.isNaN(ts)) {
          reg.lastError = `invalid 'at' timestamp: ${spec.when}`
          break
        }
        const delay = ts - Date.now()
        if (delay <= 0) {
          setImmediate(() => {
            this.fireDetached(spec.id)
          }).unref?.()
        } else {
          // A far-future `when` (> 2^31-1 ms ≈ 24.8 days out) would overflow
          // setTimeout and clamp to 1ms — firing the trigger IMMEDIATELY
          // instead of at the scheduled time. LongTimer chunks the delay so
          // an `at` weeks/months away fires exactly once, when it should.
          const t = new LongTimer(delay, () => {
            this.fireDetached(spec.id)
          })
          this.atTimers.set(spec.id, t)
        }
        break
      }
      case 'webhook': {
        const methods =
          spec.provider === 'ms-graph'
            ? new Set(['GET', 'POST', (spec.method ?? 'POST').toUpperCase()])
            : new Set([(spec.method ?? 'POST').toUpperCase()])
        for (const method of methods) {
          const key = `${method} ${spec.path}`
          const existing = this.webhookRoutes.get(key)
          if (existing !== undefined && existing !== spec.id) {
            reg.lastError = `webhook ${key} already bound to trigger ${existing}`
            break
          }
        }
        if (reg.lastError !== undefined) break
        for (const method of methods) this.webhookRoutes.set(`${method} ${spec.path}`, spec.id)
        break
      }
      case 'poll': {
        if (!isValidIntervalMs(spec.everyMs)) {
          reg.lastError = `invalid poll everyMs=${spec.everyMs} (must be 1..${MAX_INTERVAL_MS}ms)`
          break
        }
        const source = this.pollSources.get(spec.sourceFnId)
        if (source === undefined) {
          reg.lastError = `poll source not registered: ${spec.sourceFnId}`
          break
        }
        const dedupeFn =
          spec.dedupeKeyFnId !== undefined
            ? (this.pollDedupeKeyFns.get(spec.dedupeKeyFnId) ?? defaultDedupeKey)
            : defaultDedupeKey
        const tick = async () => {
          if (this.stopping) return
          try {
            const value = await source()
            const key = dedupeFn(value)
            const last = this.pollLastKey.get(spec.id)
            if (key !== last) {
              this.pollLastKey.set(spec.id, key)
              if (last !== undefined) {
                // Skip the very first observation so polling doesn't fire on
                // initial state. Callers that want fire-on-startup can pair
                // an `immediate` trigger with the same workflowId.
                await this.fire(spec.id)
              }
            }
          } catch (err) {
            reg.lastError = (err as Error).message
          }
        }
        // First tick records baseline; subsequent ticks fire on change.
        void tick()
        const t = setInterval(() => {
          void tick()
        }, spec.everyMs)
        t.unref?.()
        this.pollTimers.set(spec.id, t)
        break
      }
      case 'file-watch': {
        try {
          const watcher = new FileWatchTrigger(spec)
          watcher.start((payload) => {
            this.fireDetached(spec.id, undefined, payload)
          })
          this.fileWatchers.set(spec.id, watcher)
        } catch (err) {
          reg.lastError = `file-watch start failed: ${(err as Error).message}`
        }
        break
      }
      case 'event-source': {
        try {
          const manager = new EventSourceManager(
            spec,
            (payload) => {
              this.fireDetached(spec.id, undefined, payload)
            },
            // Async errors from `source: 'custom'` start() that returns a
            // rejecting promise used to be silently swallowed; surface them
            // through the same lastError slot a sync throw would land in.
            (err) => {
              const current = this.registrations.get(spec.id)
              if (current !== undefined) {
                current.lastError = `event-source start failed: ${err.message}`
              }
            },
          )
          manager.start()
          this.eventSourceManagers.set(spec.id, manager)
        } catch (err) {
          reg.lastError = `event-source start failed: ${(err as Error).message}`
        }
        break
      }
      case 'queue': {
        const driver = this.queueDrivers.get(spec.driver)
        if (driver === undefined) {
          reg.lastError = `queue driver not registered: ${spec.driver}`
          break
        }
        try {
          const startResult = driver.start({
            ...(spec.config !== undefined && { config: spec.config }),
            onMessage: async (payload?: unknown) => {
              await this.fire(spec.id, undefined, payload)
            },
          })
          if (startResult instanceof Promise) {
            void startResult.catch((err: Error) => {
              reg.lastError = `queue driver start failed: ${err.message}`
            })
          }
          this.queueDriverBindings.set(spec.id, spec.driver)
        } catch (err) {
          reg.lastError = `queue driver start failed: ${(err as Error).message}`
        }
        break
      }
      case 'manual':
        // Manual triggers fire only via fire(id).
        break
    }
    return reg
  }

  unregister(id: string): void {
    const t1 = this.intervalTimers.get(id)
    const t2 = this.cronTimers.get(id)
    const t3 = this.atTimers.get(id)
    const t4 = this.pollTimers.get(id)
    const watcher = this.fileWatchers.get(id)
    const eventSource = this.eventSourceManagers.get(id)
    if (t1 !== undefined) {
      clearInterval(t1)
      this.intervalTimers.delete(id)
    }
    if (t2 !== undefined) {
      t2.clear()
      this.cronTimers.delete(id)
    }
    if (t3 !== undefined) {
      t3.clear()
      this.atTimers.delete(id)
    }
    if (t4 !== undefined) {
      clearInterval(t4)
      this.pollTimers.delete(id)
    }
    if (watcher !== undefined) {
      watcher.stop()
      this.fileWatchers.delete(id)
    }
    if (eventSource !== undefined) {
      eventSource.stop()
      this.eventSourceManagers.delete(id)
    }
    // Remove webhook route if any.
    for (const [key, triggerId] of this.webhookRoutes.entries()) {
      if (triggerId === id) this.webhookRoutes.delete(key)
    }
    // Stop the queue driver bound to this trigger, if any.
    const driverId = this.queueDriverBindings.get(id)
    if (driverId !== undefined) {
      const driver = this.queueDrivers.get(driverId)
      if (driver !== undefined) {
        const r = driver.stop()
        if (r instanceof Promise) void r.catch(() => {})
      }
      this.queueDriverBindings.delete(id)
    }
    this.pollLastKey.delete(id)
    this.registrations.delete(id)
    this.queues.delete(id)
  }

  /**
   * Fire-and-forget a fire() from a timer/interval/poll callback. fire() catches
   * onFire errors inside dispatch(), but a synchronous throw before that — or any
   * stray rejection — would otherwise surface as an UnhandledPromiseRejection on
   * the gateway loop (forbidden). Route every escape to onFireError instead of
   * letting it propagate or swallowing it silently.
   */
  private fireDetached(id: string, when?: Date, payload?: unknown): void {
    void this.fire(id, when, payload).catch((err) => this.opts.onFireError?.(id, err))
  }

  private trackDispatch(promise: Promise<void>): void {
    this.pendingDispatches.add(promise)
    promise.finally(() => {
      this.pendingDispatches.delete(promise)
    })
  }

  async fire(id: string, when?: Date, payload?: unknown): Promise<FireStatus> {
    if (this.stopping) return 'stopping'
    const reg = this.registrations.get(id)
    if (reg === undefined) return 'unknown'
    // Per-fire payload from the source (queue driver, webhook adapter) takes
    // precedence; otherwise fall back to the registration's stored `input`
    // so workflows scheduled with `skelm schedule add --input <json>` see
    // that JSON as the pipeline input rather than the trigger metadata.
    const effectivePayload = payload !== undefined ? payload : reg.input
    const ctx: FireContext = {
      triggerId: id,
      workflowId: reg.spec.workflowId,
      firedAt: (when ?? new Date()).toISOString(),
      ...(effectivePayload !== undefined && { payload: effectivePayload }),
    }
    // Parallel triggers bypass the per-trigger inflight gate entirely:
    // they multiplex over independent sub-resources (e.g. a persistent
    // workflow keys by sessionKey), so serializing at the trigger level
    // would coalesce or drop fires that actually target distinct sessions.
    // Same-session ordering, when required, is owned by the dispatched
    // workflow itself (runPersistentWorkflowTurn's per-(workflowId, sessionKey)
    // lock), not by this trigger-level gate.
    if (reg.parallel === true) {
      reg.lastFiredAt = ctx.firedAt
      reg.fired += 1
      const dispatch = Promise.resolve()
        .then(() => this.opts.onFire(ctx))
        .catch((err) => {
          reg.lastError = (err as Error).message
          this.opts.onFireError?.(reg.spec.id, err)
        })
      this.trackDispatch(dispatch)
      await Promise.resolve()
      return 'dispatched'
    }
    // Check-and-set inflight atomically. JS is single-threaded so concurrent
    // fire() calls cannot interleave between the read on the next line and
    // the assignment two lines down — but they CAN interleave between this
    // synchronous check and the eventual `dispatch()` body if we let
    // dispatch() be the one to set inflight (as it used to). #184: closing
    // that race is what makes overlap: 'skip' / 'queue' actually enforce on
    // burst fires from POST /triggers/:id/fire.
    if (reg.inflight) {
      switch (reg.overlap) {
        case 'skip':
          return 'skipped'
        case 'queue': {
          const q = this.queues.get(id) ?? []
          const cap = reg.maxQueueDepth ?? this.opts.defaultMaxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH
          if (q.length >= cap) {
            reg.dropped += 1
            this.opts.onQueueDrop?.(id, q.length)
            return 'skipped'
          }
          q.push(ctx)
          this.queues.set(id, q)
          return 'queued'
        }
        case 'cancel':
          // No real cancellation channel in Phase 10; treat as skip.
          return 'cancelled'
      }
    }
    reg.inflight = true
    const dispatch = Promise.resolve()
      .then(() => this.dispatch(reg, ctx))
      .catch((err) => {
        reg.lastError = (err as Error).message
        this.opts.onFireError?.(reg.spec.id, err)
        reg.inflight = false
      })
    this.trackDispatch(dispatch)
    await Promise.resolve()
    return 'dispatched'
  }

  private async dispatch(reg: TriggerRegistration, ctx: FireContext): Promise<void> {
    // Caller must have already set `reg.inflight = true` *before* the await
    // so that concurrent fire() invocations observe inflight and route
    // through the overlap policy.
    //
    // Drain the queue inside a while loop so inflight stays true across
    // back-to-back fires. The previous recursive form cleared inflight in
    // the finally and re-set it on the next iteration, leaving a window
    // where a new fire() observed inflight=false and either ran in
    // parallel (overlap=skip would have skipped if inflight=true) or
    // reordered with the queued items. The loop holds inflight=true
    // until the queue is fully drained, and uses iteration instead of
    // async-stack recursion so long backlogs don't grow stack frames.
    try {
      let current: FireContext | undefined = ctx
      while (current !== undefined) {
        reg.lastFiredAt = current.firedAt
        reg.fired += 1
        try {
          await this.opts.onFire(current)
        } catch (err) {
          reg.lastError = (err as Error).message
          this.opts.onFireError?.(reg.spec.id, err)
        }
        if (this.stopping) break
        current = this.queues.get(reg.spec.id)?.shift()
      }
    } finally {
      reg.inflight = false
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    for (const t of this.intervalTimers.values()) clearInterval(t)
    for (const t of this.cronTimers.values()) t.clear()
    for (const t of this.atTimers.values()) t.clear()
    for (const t of this.pollTimers.values()) clearInterval(t)
    for (const watcher of this.fileWatchers.values()) watcher.stop()
    for (const manager of this.eventSourceManagers.values()) manager.stop()
    for (const driver of this.queueDrivers.values()) {
      const r = driver.stop()
      if (r instanceof Promise) await r.catch(() => {})
    }
    while (this.pendingDispatches.size > 0) {
      await Promise.allSettled(Array.from(this.pendingDispatches))
    }
    this.intervalTimers.clear()
    this.cronTimers.clear()
    this.atTimers.clear()
    this.pollTimers.clear()
    this.fileWatchers.clear()
    this.eventSourceManagers.clear()
    this.webhookRoutes.clear()
    this.queueDriverBindings.clear()
  }
}

function defaultDedupeKey(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
