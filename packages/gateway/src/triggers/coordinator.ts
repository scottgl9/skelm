import { type ParsedCron, nextFireTime, parseCron } from './cron-parser.js'
import { type DedupeStore, InMemoryDedupeStore } from './dedupe-store.js'
import { EventSourceManager } from './event-source-manager.js'
import { FileWatchTrigger } from './file-watcher.js'
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
  private cronTimers: Map<string, NodeJS.Timeout> = new Map()
  private fileWatchers: Map<string, FileWatchTrigger> = new Map()
  private eventSourceManagers: Map<string, EventSourceManager> = new Map()
  private atTimers: Map<string, NodeJS.Timeout> = new Map()
  private pollTimers: Map<string, NodeJS.Timeout> = new Map()
  private webhookRoutes: Map<string, string> = new Map() // path:method → triggerId
  private pollSources: Map<string, PollSourceFn> = new Map()
  private pollDedupeKeyFns: Map<string, PollDedupeKeyFn> = new Map()
  private pollLastKey: Map<string, string> = new Map()
  private queueDrivers: Map<string, QueueDriver> = new Map()
  private queueDriverBindings: Map<string, string> = new Map() // triggerId → driverId
  private queues: Map<string, FireContext[]> = new Map()
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
    if (next === null) return
    const delay = Math.max(0, next.getTime() - Date.now())
    const t = setTimeout(() => {
      // Schedule the *next* fire before invoking this one so a fire that
      // outlives its period does not skip ticks. The coordinator's
      // overlap policy on the registration decides what happens when a
      // fresh fire arrives while the previous one is still running.
      this.scheduleNextCron(triggerId, parsed)
      void this.fire(triggerId, next)
    }, delay)
    t.unref?.()
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

  register(
    spec: TriggerSpec,
    overlap?: OverlapPolicy,
    options: { input?: unknown; declared?: boolean; maxQueueDepth?: number } = {},
  ): TriggerRegistration {
    const reg: TriggerRegistration = {
      spec,
      overlap: overlap ?? this.opts.defaultOverlap ?? 'skip',
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
        const t = setInterval(() => {
          void this.fire(spec.id)
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
          void this.fire(spec.id)
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
            void this.fire(spec.id)
          }).unref?.()
        } else {
          const t = setTimeout(() => {
            void this.fire(spec.id)
          }, delay)
          t.unref?.()
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
            void this.fire(spec.id, undefined, payload)
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
              void this.fire(spec.id, undefined, payload)
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
      clearTimeout(t2)
      this.cronTimers.delete(id)
    }
    if (t3 !== undefined) {
      clearTimeout(t3)
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
            return
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
    await this.dispatch(reg, ctx)
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
    for (const t of this.cronTimers.values()) clearTimeout(t)
    for (const t of this.atTimers.values()) clearTimeout(t)
    for (const t of this.pollTimers.values()) clearInterval(t)
    for (const watcher of this.fileWatchers.values()) watcher.stop()
    for (const manager of this.eventSourceManagers.values()) manager.stop()
    for (const driver of this.queueDrivers.values()) {
      const r = driver.stop()
      if (r instanceof Promise) await r.catch(() => {})
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
