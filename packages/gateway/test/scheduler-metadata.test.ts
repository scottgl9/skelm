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
})
