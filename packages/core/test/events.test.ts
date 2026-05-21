import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../src/builders.js'
import { EventBus, type RunEvent } from '../src/events.js'
import { runPipeline } from '../src/runner.js'

describe('EventBus', () => {
  it('publishes events to all subscribers in registration order', () => {
    const bus = new EventBus()
    const calls: string[] = []
    bus.subscribe(() => calls.push('a'))
    bus.subscribe(() => calls.push('b'))
    bus.publish({ type: 'run.started', runId: 'r', at: 0 })
    expect(calls).toEqual(['a', 'b'])
  })

  it('unsubscribe stops further events to that listener', () => {
    const bus = new EventBus()
    let count = 0
    const unsub = bus.subscribe(() => count++)
    bus.publish({ type: 'run.started', runId: 'r', at: 0 })
    unsub()
    bus.publish({ type: 'run.started', runId: 'r', at: 1 })
    expect(count).toBe(1)
  })

  it('forRun filters events by runId', () => {
    const bus = new EventBus()
    const seen: RunEvent[] = []
    bus.forRun('r1', (e) => seen.push(e))
    bus.publish({ type: 'run.started', runId: 'r1', at: 0 })
    bus.publish({ type: 'run.started', runId: 'r2', at: 0 })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.runId).toBe('r1')
  })

  it('forRun is indexed by runId — global subscribers do not see per-run events twice', () => {
    const bus = new EventBus()
    let global = 0
    let r1 = 0
    let r2 = 0
    bus.subscribe(() => global++)
    bus.forRun('r1', () => r1++)
    bus.forRun('r2', () => r2++)
    bus.publish({ type: 'run.started', runId: 'r1', at: 0 })
    bus.publish({ type: 'run.started', runId: 'r2', at: 0 })
    bus.publish({ type: 'run.started', runId: 'r3', at: 0 })
    expect(global).toBe(3)
    expect(r1).toBe(1)
    expect(r2).toBe(1)
    expect(bus.listenerCount).toBe(3)
  })

  it('forRun unsubscribe cleans up empty per-run bucket', () => {
    const bus = new EventBus()
    const unsub = bus.forRun('r1', () => {})
    expect(bus.listenerCount).toBe(1)
    unsub()
    expect(bus.listenerCount).toBe(0)
    // After cleanup, publishing for that runId is a no-op (regression: ensure
    // we don't keep an empty Set in the map that would still be iterated).
    expect(() => bus.publish({ type: 'run.started', runId: 'r1', at: 0 })).not.toThrow()
  })

  it('a throwing subscriber does not break the bus or other subscribers', () => {
    const bus = new EventBus()
    let after = 0
    bus.subscribe(() => {
      throw new Error('intentional')
    })
    bus.subscribe(() => {
      after++
    })
    expect(() => bus.publish({ type: 'run.started', runId: 'r', at: 0 })).not.toThrow()
    expect(after).toBe(1)
  })
})

describe('runPipeline — event publication', () => {
  it('publishes run.created, run.started, step.start, step.complete, run.completed for happy path', async () => {
    const bus = new EventBus()
    const events: RunEvent[] = []
    bus.subscribe((e) => events.push(e))

    const wf = pipeline({
      id: 'happy',
      steps: [code({ id: 'a', run: () => ({ ok: true }) })],
    })

    await runPipeline(wf, undefined, { events: bus })

    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'run.created',
      'run.started',
      'step.start',
      'step.complete',
      'run.completed',
    ])
  })

  it('publishes step.error and run.failed when a step throws', async () => {
    const bus = new EventBus()
    const events: RunEvent[] = []
    bus.subscribe((e) => events.push(e))

    const wf = pipeline({
      id: 'fails',
      steps: [
        code({
          id: 'boom',
          run: () => {
            throw new Error('intentional')
          },
        }),
      ],
    })

    await runPipeline(wf, undefined, { events: bus })

    const types = events.map((e) => e.type)
    expect(types).toContain('step.error')
    expect(types).toContain('run.failed')
    expect(types).not.toContain('run.completed')
  })

  it('publishes run.cancelled when the signal is pre-aborted', async () => {
    const bus = new EventBus()
    const events: RunEvent[] = []
    bus.subscribe((e) => events.push(e))

    const controller = new AbortController()
    controller.abort()

    const wf = pipeline({
      id: 'cancel',
      steps: [code({ id: 'noop', run: () => ({}) })],
    })

    await runPipeline(wf, undefined, { events: bus, signal: controller.signal })

    expect(events.map((e) => e.type)).toContain('run.cancelled')
  })

  it('every step.complete carries durationMs >= 0', async () => {
    const bus = new EventBus()
    const events: RunEvent[] = []
    bus.subscribe((e) => events.push(e))

    const wf = pipeline({
      id: 'durations',
      steps: [code({ id: 'noop', run: () => ({}) })],
    })

    await runPipeline(wf, undefined, { events: bus })

    const completes = events.filter(
      (e): e is Extract<RunEvent, { type: 'step.complete' }> => e.type === 'step.complete',
    )
    expect(completes).toHaveLength(1)
    expect(completes[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })
})
