import { EventBus } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { MetricsCollector } from '../src/index.js'

describe('MetricsCollector', () => {
  it('counts run lifecycle and step results from a subscribed EventBus', () => {
    const bus = new EventBus()
    const m = new MetricsCollector()
    m.attach(bus)

    bus.publish({ type: 'run.created', runId: 'r1', pipelineId: 'p', input: {}, at: 1 })
    bus.publish({ type: 'run.started', runId: 'r1', at: 2 })
    bus.publish({
      type: 'step.complete',
      runId: 'r1',
      stepId: 's1',
      kind: 'code',
      output: {},
      durationMs: 42,
      at: 3,
    })
    bus.publish({ type: 'run.completed', runId: 'r1', output: {}, durationMs: 50, at: 4 })

    bus.publish({ type: 'run.started', runId: 'r2', at: 5 })
    bus.publish({
      type: 'step.error',
      runId: 'r2',
      stepId: 's1',
      kind: 'agent',
      error: { name: 'X', message: 'boom' },
      durationMs: 10,
      at: 6,
    })
    bus.publish({ type: 'run.failed', runId: 'r2', error: { name: 'X', message: 'boom' }, at: 7 })

    const out = m.render()
    expect(out).toContain('skelm_runs_started_total 2')
    expect(out).toContain('skelm_runs_total{status="completed"} 1')
    expect(out).toContain('skelm_runs_total{status="failed"} 1')
    expect(out).toContain('skelm_runs_total{status="cancelled"} 0')
    expect(out).toContain('skelm_runs_in_flight 0')
    expect(out).toContain('skelm_steps_total{kind="code",status="completed"} 1')
    expect(out).toContain('skelm_steps_total{kind="agent",status="error"} 1')
    expect(out).toContain('skelm_step_duration_ms_count 1')
    expect(out).toContain('skelm_step_duration_ms_sum 42')
  })

  it('tracks in-flight runs as the difference of started and terminal events', () => {
    const bus = new EventBus()
    const m = new MetricsCollector()
    m.attach(bus)

    bus.publish({ type: 'run.started', runId: 'a', at: 1 })
    bus.publish({ type: 'run.started', runId: 'b', at: 2 })
    bus.publish({ type: 'run.started', runId: 'c', at: 3 })
    expect(m.render()).toContain('skelm_runs_in_flight 3')
    bus.publish({ type: 'run.completed', runId: 'a', output: {}, durationMs: 1, at: 4 })
    bus.publish({ type: 'run.cancelled', runId: 'b', at: 5 })
    expect(m.render()).toContain('skelm_runs_in_flight 1')
  })

  it('exposes manual gauges for approvals and trigger fires', () => {
    const m = new MetricsCollector()
    m.setApprovalsPending(5)
    m.recordTriggerFire('cron-1')
    m.recordTriggerFire('cron-1')
    m.recordTriggerFire('webhook-x')
    const out = m.render()
    expect(out).toContain('skelm_approvals_pending 5')
    expect(out).toContain('skelm_trigger_fires_total{trigger="cron-1"} 2')
    expect(out).toContain('skelm_trigger_fires_total{trigger="webhook-x"} 1')
  })

  it('renders Prometheus-shape histogram with cumulative buckets', () => {
    const bus = new EventBus()
    const m = new MetricsCollector({ durationBucketsMs: [10, 100, 1000] })
    m.attach(bus)
    for (const d of [5, 50, 500, 5000]) {
      bus.publish({
        type: 'step.complete',
        runId: 'r',
        stepId: 's',
        kind: 'code',
        output: {},
        durationMs: d,
        at: 1,
      })
    }
    const out = m.render()
    // 5ms ≤ 10 → bucket 1
    // 50ms ≤ 100 → bucket 2 (cumulative 2)
    // 500ms ≤ 1000 → bucket 3 (cumulative 3)
    // 5000ms → +Inf only (cumulative 4)
    expect(out).toContain('skelm_step_duration_ms_bucket{le="10"} 1')
    expect(out).toContain('skelm_step_duration_ms_bucket{le="100"} 2')
    expect(out).toContain('skelm_step_duration_ms_bucket{le="1000"} 3')
    expect(out).toContain('skelm_step_duration_ms_bucket{le="+Inf"} 4')
    expect(out).toContain('skelm_step_duration_ms_count 4')
  })
})
