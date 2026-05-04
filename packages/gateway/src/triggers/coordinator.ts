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
}

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
  private queues: Map<string, FireContext[]> = new Map()
  private stopping = false

  constructor(private opts: TriggerCoordinatorOptions) {}

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

  register(spec: TriggerSpec, overlap?: OverlapPolicy): TriggerRegistration {
    const reg: TriggerRegistration = {
      spec,
      overlap: overlap ?? this.opts.defaultOverlap ?? 'skip',
      fired: 0,
      inflight: false,
    }
    this.registrations.set(spec.id, reg)
    if (spec.kind === 'interval') {
      const t = setInterval(() => {
        void this.fire(spec.id)
      }, spec.everyMs)
      t.unref?.()
      this.intervalTimers.set(spec.id, t)
    } else if (spec.kind === 'cron') {
      // Phase 10 ships a 60s tick parser stub: only `*/N * * * *` (every N
      // minutes) is recognised. Full cron parsing lands when needed.
      const everyMs = parseSimpleCron(spec.cron)
      if (everyMs !== null) {
        const t = setInterval(() => {
          void this.fire(spec.id)
        }, everyMs)
        t.unref?.()
        this.cronTimers.set(spec.id, t)
      } else {
        reg.lastError = `unsupported cron expression: ${spec.cron}`
      }
    }
    return reg
  }

  unregister(id: string): void {
    const t1 = this.intervalTimers.get(id)
    const t2 = this.cronTimers.get(id)
    if (t1 !== undefined) {
      clearInterval(t1)
      this.intervalTimers.delete(id)
    }
    if (t2 !== undefined) {
      clearInterval(t2)
      this.cronTimers.delete(id)
    }
    this.registrations.delete(id)
    this.queues.delete(id)
  }

  async fire(id: string, when?: Date): Promise<void> {
    if (this.stopping) return
    const reg = this.registrations.get(id)
    if (reg === undefined) return
    const ctx: FireContext = {
      triggerId: id,
      workflowId: reg.spec.workflowId,
      firedAt: (when ?? new Date()).toISOString(),
    }
    if (reg.inflight) {
      switch (reg.overlap) {
        case 'skip':
          return
        case 'queue': {
          const q = this.queues.get(id) ?? []
          q.push(ctx)
          this.queues.set(id, q)
          return
        }
        case 'cancel':
          // No real cancellation channel in Phase 10; treat as skip.
          return
      }
    }
    await this.dispatch(reg, ctx)
  }

  private async dispatch(reg: TriggerRegistration, ctx: FireContext): Promise<void> {
    reg.inflight = true
    reg.lastFiredAt = ctx.firedAt
    reg.fired += 1
    try {
      await this.opts.onFire(ctx)
    } catch (err) {
      reg.lastError = (err as Error).message
    } finally {
      reg.inflight = false
    }
    const queued = this.queues.get(reg.spec.id)?.shift()
    if (queued !== undefined && !this.stopping) {
      await this.dispatch(reg, queued)
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    for (const t of this.intervalTimers.values()) clearInterval(t)
    for (const t of this.cronTimers.values()) clearInterval(t)
    this.intervalTimers.clear()
    this.cronTimers.clear()
  }
}

function parseSimpleCron(expr: string): number | null {
  const m = expr.trim().match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/)
  if (m === null) return null
  const minutes = Number.parseInt(m[1] as string, 10)
  if (!Number.isFinite(minutes) || minutes <= 0) return null
  return minutes * 60_000
}
