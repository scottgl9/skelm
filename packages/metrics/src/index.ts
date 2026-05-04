import type { EventBus, RunEvent } from '@skelm/core'

/**
 * Buckets for the step-duration histogram (milliseconds). Chosen for
 * agentic workflows where step latency ranges from ~10ms (deterministic
 * code) to many minutes (LLM + tool loops).
 */
const DEFAULT_DURATION_BUCKETS_MS: readonly number[] = [
  10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000,
]

interface Histogram {
  buckets: readonly number[]
  counts: number[] // length = buckets.length + 1; last is +Inf
  sum: number
  count: number
}

function newHistogram(buckets: readonly number[]): Histogram {
  return { buckets, counts: new Array(buckets.length + 1).fill(0), sum: 0, count: 0 }
}

function observe(h: Histogram, value: number): void {
  h.sum += value
  h.count += 1
  for (let i = 0; i < h.buckets.length; i++) {
    const limit = h.buckets[i]
    if (limit !== undefined && value <= limit) {
      const c = h.counts[i] ?? 0
      h.counts[i] = c + 1
      return
    }
  }
  const last = h.counts.length - 1
  const c = h.counts[last] ?? 0
  h.counts[last] = c + 1
}

/**
 * Subscribes to an EventBus and accumulates Prometheus-shaped metrics.
 * Emits no metrics on construction; counters reflect events seen since
 * attach().
 *
 * The collector is intentionally tiny — no global registry, no namespace
 * coupling, no external dependencies. The gateway constructs one and wires
 * it to the runner's EventBus; tests can construct one and feed events
 * directly.
 */
export class MetricsCollector {
  private runsStarted = 0
  private runsByStatus: Map<string, number> = new Map()
  private stepsByKindStatus: Map<string, number> = new Map() // "kind|status" → count
  private inFlightRuns = 0
  private permissionDenials = 0
  private stepDuration: Histogram

  // Optional gauges that the gateway updates from outside (no event source).
  private approvalsPending = 0
  private triggerFires: Map<string, number> = new Map()

  constructor(opts: { durationBucketsMs?: readonly number[] } = {}) {
    this.stepDuration = newHistogram(opts.durationBucketsMs ?? DEFAULT_DURATION_BUCKETS_MS)
  }

  /**
   * Subscribe to events emitted by the bus. Returns the unsubscribe handle
   * the caller passes to detach().
   */
  attach(bus: EventBus): () => void {
    return bus.subscribe((event: RunEvent) => this.onEvent(event))
  }

  setApprovalsPending(value: number): void {
    this.approvalsPending = value
  }

  recordTriggerFire(triggerId: string): void {
    this.triggerFires.set(triggerId, (this.triggerFires.get(triggerId) ?? 0) + 1)
  }

  private onEvent(event: RunEvent): void {
    switch (event.type) {
      case 'run.started':
        this.runsStarted += 1
        this.inFlightRuns += 1
        return
      case 'run.completed':
      case 'run.failed':
      case 'run.cancelled': {
        const status = event.type.slice('run.'.length) // completed | failed | cancelled
        this.runsByStatus.set(status, (this.runsByStatus.get(status) ?? 0) + 1)
        if (this.inFlightRuns > 0) this.inFlightRuns -= 1
        return
      }
      case 'step.complete': {
        const key = `${event.kind}|completed`
        this.stepsByKindStatus.set(key, (this.stepsByKindStatus.get(key) ?? 0) + 1)
        observe(this.stepDuration, event.durationMs)
        return
      }
      case 'step.error': {
        const key = `${event.kind}|error`
        this.stepsByKindStatus.set(key, (this.stepsByKindStatus.get(key) ?? 0) + 1)
        return
      }
      case 'permission.denied':
        this.permissionDenials += 1
        return
      default:
        return
    }
  }

  /** Render in Prometheus text exposition format (v0.0.4). */
  render(): string {
    const lines: string[] = []

    lines.push('# HELP skelm_runs_started_total Total runs that reached run.started.')
    lines.push('# TYPE skelm_runs_started_total counter')
    lines.push(`skelm_runs_started_total ${this.runsStarted}`)
    lines.push('')

    lines.push('# HELP skelm_runs_total Total runs that reached a terminal status.')
    lines.push('# TYPE skelm_runs_total counter')
    for (const status of ['completed', 'failed', 'cancelled']) {
      const c = this.runsByStatus.get(status) ?? 0
      lines.push(`skelm_runs_total{status="${status}"} ${c}`)
    }
    lines.push('')

    lines.push('# HELP skelm_runs_in_flight Currently running runs.')
    lines.push('# TYPE skelm_runs_in_flight gauge')
    lines.push(`skelm_runs_in_flight ${this.inFlightRuns}`)
    lines.push('')

    lines.push('# HELP skelm_steps_total Step results by kind and status.')
    lines.push('# TYPE skelm_steps_total counter')
    for (const [key, count] of this.stepsByKindStatus.entries()) {
      const [kind, status] = key.split('|')
      lines.push(`skelm_steps_total{kind="${kind}",status="${status}"} ${count}`)
    }
    lines.push('')

    lines.push('# HELP skelm_step_duration_ms Step duration in milliseconds.')
    lines.push('# TYPE skelm_step_duration_ms histogram')
    let cumulative = 0
    for (let i = 0; i < this.stepDuration.buckets.length; i++) {
      cumulative += this.stepDuration.counts[i] ?? 0
      lines.push(`skelm_step_duration_ms_bucket{le="${this.stepDuration.buckets[i]}"} ${cumulative}`)
    }
    cumulative += this.stepDuration.counts[this.stepDuration.counts.length - 1] ?? 0
    lines.push(`skelm_step_duration_ms_bucket{le="+Inf"} ${cumulative}`)
    lines.push(`skelm_step_duration_ms_sum ${this.stepDuration.sum}`)
    lines.push(`skelm_step_duration_ms_count ${this.stepDuration.count}`)
    lines.push('')

    lines.push('# HELP skelm_permission_denials_total Total permission-denied events.')
    lines.push('# TYPE skelm_permission_denials_total counter')
    lines.push(`skelm_permission_denials_total ${this.permissionDenials}`)
    lines.push('')

    lines.push('# HELP skelm_approvals_pending Pending approval requests.')
    lines.push('# TYPE skelm_approvals_pending gauge')
    lines.push(`skelm_approvals_pending ${this.approvalsPending}`)
    lines.push('')

    lines.push('# HELP skelm_trigger_fires_total Trigger fires by id.')
    lines.push('# TYPE skelm_trigger_fires_total counter')
    for (const [id, count] of this.triggerFires.entries()) {
      lines.push(`skelm_trigger_fires_total{trigger="${id}"} ${count}`)
    }

    return `${lines.join('\n')}\n`
  }
}
