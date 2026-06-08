import { describe, expect, it } from 'vitest'
import { TriggerCoordinator } from '../src/index.js'

describe('TriggerCoordinator metadata', () => {
  it('records queue depth, running count, overlap decisions, and terminal outcomes', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const c = new TriggerCoordinator({
      defaultOverlap: 'queue',
      onFire: async () => {
        await blocked
      },
    })
    c.register({ kind: 'manual', id: 'meta', workflowId: 'wf' })

    const first = c.fire('meta')
    await new Promise((r) => setTimeout(r, 5))
    const second = await c.fire('meta')
    const reg = c.get('meta')

    expect(second).toBe('queued')
    expect(c.queueDepth('meta')).toBe(1)
    expect(c.runningCount('meta')).toBe(1)
    expect(reg?.lastOverlapDecision).toBe('queued')
    expect(reg?.lastOutcome).toBe('queued')

    release?.()
    await first
    await c.stop()
    expect(c.get('meta')?.lastOutcome).toBe('succeeded')
  })

  it('timestamps registration errors', async () => {
    const c = new TriggerCoordinator({ onFire: async () => {} })
    const reg = c.register({ kind: 'interval', id: 'bad', workflowId: 'wf', everyMs: 0 })

    expect(reg.lastError).toContain('invalid interval')
    expect(Date.parse(reg.lastErrorAt ?? '')).not.toBeNaN()
    expect(reg.lastOutcome).toBe('failed')
    await c.stop()
  })

  it('records failed outcome when any queued dispatch item fails', async () => {
    let calls = 0
    const c = new TriggerCoordinator({
      defaultOverlap: 'queue',
      onFire: async () => {
        calls += 1
        if (calls === 1) throw new Error('first failed')
      },
    })
    c.register({ kind: 'manual', id: 'partial', workflowId: 'wf' })

    const first = c.fire('partial')
    const second = await c.fire('partial')
    expect(second).toBe('queued')
    await first
    await c.stop()

    expect(c.get('partial')?.lastOutcome).toBe('failed')
    expect(c.get('partial')?.lastError).toBe('first failed')
  })

  it('records parallel dispatch decisions and terminal outcomes', async () => {
    const c = new TriggerCoordinator({ onFire: async () => {} })
    c.register({ kind: 'manual', id: 'parallel', workflowId: 'wf' })
    c.markParallel('parallel')

    const status = await c.fire('parallel')
    await c.stop()

    expect(status).toBe('dispatched')
    expect(c.get('parallel')?.lastOverlapDecision).toBe('dispatched')
    expect(c.get('parallel')?.lastOutcome).toBe('succeeded')
  })

  it('resets poll source failures after a successful poll tick without dispatch', async () => {
    let fail = true
    const c = new TriggerCoordinator({ onFire: async () => {} })
    c.registerPollSource('source', () => {
      if (fail) throw new Error('source unavailable')
      return 'stable'
    })
    c.register({ kind: 'poll', id: 'poll', workflowId: 'wf', everyMs: 20, sourceFnId: 'source' })

    await new Promise((r) => setTimeout(r, 5))
    expect(c.get('poll')?.lastOutcome).toBe('failed')

    fail = false
    await new Promise((r) => setTimeout(r, 30))
    expect(c.get('poll')?.lastOutcome).toBe('succeeded')
    await c.stop()
  })
})
