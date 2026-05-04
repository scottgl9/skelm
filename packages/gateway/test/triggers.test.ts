import { describe, expect, it } from 'vitest'
import { TriggerCoordinator } from '../src/index.js'

describe('TriggerCoordinator', () => {
  it('manual fire dispatches through onFire and increments counter', async () => {
    const fires: string[] = []
    const c = new TriggerCoordinator({ onFire: async (ctx) => void fires.push(ctx.workflowId) })
    c.register({ kind: 'manual', id: 't1', workflowId: 'wf-a' })
    await c.fire('t1')
    await c.fire('t1')
    expect(fires).toEqual(['wf-a', 'wf-a'])
    expect(c.get('t1')?.fired).toBe(2)
    await c.stop()
  })

  it("'skip' overlap policy drops fires while one is in flight", async () => {
    let resolveBlock: (() => void) | null = null
    const inFlight = new Promise<void>((r) => {
      resolveBlock = r
    })
    let fires = 0
    const c = new TriggerCoordinator({
      defaultOverlap: 'skip',
      onFire: async () => {
        fires++
        await inFlight
      },
    })
    c.register({ kind: 'manual', id: 't', workflowId: 'wf' })
    const first = c.fire('t')
    await new Promise((r) => setTimeout(r, 5))
    await c.fire('t') // should be skipped — first still in flight
    expect(fires).toBe(1)
    resolveBlock?.()
    await first
    await c.stop()
  })

  it("'queue' overlap policy runs the queued fire after the in-flight one finishes", async () => {
    let resolveBlock: (() => void) | null = null
    const block = new Promise<void>((r) => {
      resolveBlock = r
    })
    const fires: string[] = []
    const c = new TriggerCoordinator({
      defaultOverlap: 'queue',
      onFire: async (ctx) => {
        fires.push(ctx.firedAt)
        if (fires.length === 1) await block
      },
    })
    c.register({ kind: 'manual', id: 't', workflowId: 'wf' })
    const first = c.fire('t')
    await new Promise((r) => setTimeout(r, 5))
    const second = c.fire('t')
    expect(fires.length).toBe(1)
    resolveBlock?.()
    await Promise.all([first, second])
    expect(fires.length).toBe(2)
    await c.stop()
  })

  it('records onFire errors as lastError without throwing', async () => {
    const c = new TriggerCoordinator({
      onFire: async () => {
        throw new Error('boom')
      },
    })
    c.register({ kind: 'manual', id: 't', workflowId: 'wf' })
    await c.fire('t')
    expect(c.get('t')?.lastError).toBe('boom')
    await c.stop()
  })
})
