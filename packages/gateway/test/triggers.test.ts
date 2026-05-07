import { describe, expect, it } from 'vitest'
import { InMemoryQueueDriver, TriggerCoordinator } from '../src/index.js'

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

  it("'immediate' kind fires once on register", async () => {
    const fires: string[] = []
    const c = new TriggerCoordinator({ onFire: async (ctx) => void fires.push(ctx.workflowId) })
    c.register({ kind: 'immediate', id: 't-imm', workflowId: 'wf' })
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(fires).toEqual(['wf'])
    expect(c.get('t-imm')?.fired).toBe(1)
    await c.stop()
  })

  it("'at' kind fires at the given time (or immediately when in the past)", async () => {
    const fires: number[] = []
    const c = new TriggerCoordinator({
      onFire: async () => void fires.push(Date.now()),
    })
    // Past timestamp — should fire on next tick.
    c.register({
      kind: 'at',
      id: 't-past',
      workflowId: 'wf',
      when: new Date(Date.now() - 1000).toISOString(),
    })
    // Future timestamp ~50ms.
    const future = new Date(Date.now() + 50).toISOString()
    c.register({ kind: 'at', id: 't-fut', workflowId: 'wf', when: future })
    await new Promise((r) => setTimeout(r, 120))
    expect(fires).toHaveLength(2)
    expect(c.get('t-past')?.fired).toBe(1)
    expect(c.get('t-fut')?.fired).toBe(1)
    await c.stop()
  })

  it("'at' kind records lastError on an unparseable timestamp", async () => {
    const c = new TriggerCoordinator({ onFire: async () => {} })
    const reg = c.register({
      kind: 'at',
      id: 't-bad',
      workflowId: 'wf',
      when: 'not a date',
    })
    expect(reg.lastError).toContain("invalid 'at' timestamp")
    await c.stop()
  })

  it("'webhook' kind binds to path+method and resolves them", async () => {
    const c = new TriggerCoordinator({ onFire: async () => {} })
    c.register({
      kind: 'webhook',
      id: 't-hook',
      workflowId: 'wf',
      path: '/hooks/github',
      method: 'POST',
    })
    expect(c.resolveWebhook('/hooks/github', 'POST')).toBe('t-hook')
    expect(c.resolveWebhook('/hooks/github', 'GET')).toBeUndefined()
    expect(c.resolveWebhook('/missing', 'POST')).toBeUndefined()

    // Re-registering the same path on a different trigger reports collision.
    const reg = c.register({
      kind: 'webhook',
      id: 't-other',
      workflowId: 'wf',
      path: '/hooks/github',
    })
    expect(reg.lastError).toContain('already bound')
    await c.stop()
  })

  it("'webhook' route is removed on unregister", async () => {
    const c = new TriggerCoordinator({ onFire: async () => {} })
    c.register({ kind: 'webhook', id: 't', workflowId: 'wf', path: '/x' })
    expect(c.resolveWebhook('/x', 'POST')).toBe('t')
    c.unregister('t')
    expect(c.resolveWebhook('/x', 'POST')).toBeUndefined()
  })

  it("'poll' kind fires when the source's dedupe key changes", async () => {
    const fires: string[] = []
    const c = new TriggerCoordinator({ onFire: async (ctx) => void fires.push(ctx.firedAt) })
    let counter = 0
    c.registerPollSource('counter-src', () => counter)
    c.register({
      kind: 'poll',
      id: 't-poll',
      workflowId: 'wf',
      everyMs: 20,
      sourceFnId: 'counter-src',
    })
    // First tick records baseline (counter=0) without firing.
    await new Promise((r) => setTimeout(r, 30))
    expect(fires).toHaveLength(0)
    counter = 1
    await new Promise((r) => setTimeout(r, 30))
    expect(fires).toHaveLength(1)
    // No change → no fire.
    await new Promise((r) => setTimeout(r, 30))
    expect(fires).toHaveLength(1)
    counter = 2
    await new Promise((r) => setTimeout(r, 30))
    expect(fires).toHaveLength(2)
    await c.stop()
  })

  it("'queue' kind fires when the bound driver delivers a message", async () => {
    const fires: string[] = []
    const c = new TriggerCoordinator({ onFire: async (ctx) => void fires.push(ctx.workflowId) })
    const driver = new InMemoryQueueDriver()
    c.registerQueueDriver('memq', driver)
    // overlap: 'queue' so a burst of messages all fire even if onFire is async.
    c.register({ kind: 'queue', id: 't-q', workflowId: 'wf-q', driver: 'memq' }, 'queue')
    driver.push()
    driver.push()
    driver.push()
    await new Promise((r) => setTimeout(r, 20))
    expect(fires).toHaveLength(3)
    await c.stop()
  })

  it("'queue' driver payload is forwarded onto FireContext", async () => {
    const payloads: unknown[] = []
    const c = new TriggerCoordinator({ onFire: async (ctx) => void payloads.push(ctx.payload) })
    const driver = new InMemoryQueueDriver()
    c.registerQueueDriver('memq', driver)
    c.register({ kind: 'queue', id: 't-q', workflowId: 'wf', driver: 'memq' }, 'queue')
    driver.push({ chatId: '1', text: 'hi' })
    driver.push({ chatId: '2', text: 'bye' })
    await new Promise((r) => setTimeout(r, 20))
    expect(payloads).toEqual([
      { chatId: '1', text: 'hi' },
      { chatId: '2', text: 'bye' },
    ])
    await c.stop()
  })

  it('manual fire(id, when, payload) propagates payload to onFire', async () => {
    const seen: unknown[] = []
    const c = new TriggerCoordinator({ onFire: async (ctx) => void seen.push(ctx.payload) })
    c.register({ kind: 'manual', id: 'm', workflowId: 'wf' })
    await c.fire('m', undefined, { hello: 'world' })
    expect(seen).toEqual([{ hello: 'world' }])
    await c.stop()
  })

  it('register({ input }) is used as default payload on fires that supply none', async () => {
    const seen: unknown[] = []
    const c = new TriggerCoordinator({ onFire: async (ctx) => void seen.push(ctx.payload) })
    c.register({ kind: 'manual', id: 'm', workflowId: 'wf' }, undefined, {
      input: { hello: 'from-schedule' },
    })
    // fire() without an explicit payload → registration's input is used.
    await c.fire('m')
    // fire() with an explicit payload → that payload wins, registration input is ignored.
    await c.fire('m', undefined, { hello: 'from-source' })
    expect(seen).toEqual([{ hello: 'from-schedule' }, { hello: 'from-source' }])
    await c.stop()
  })

  it('register without input keeps payload undefined when fire() supplies none', async () => {
    const seen: unknown[] = []
    const c = new TriggerCoordinator({ onFire: async (ctx) => void seen.push(ctx.payload) })
    c.register({ kind: 'manual', id: 'm', workflowId: 'wf' })
    await c.fire('m')
    expect(seen).toEqual([undefined])
    await c.stop()
  })

  it("'queue' records lastError when the named driver is not registered", async () => {
    const c = new TriggerCoordinator({ onFire: async () => {} })
    const reg = c.register({ kind: 'queue', id: 't', workflowId: 'wf', driver: 'missing' })
    expect(reg.lastError).toContain('queue driver not registered')
    await c.stop()
  })

  it("'poll' records lastError when the source is not registered", async () => {
    const c = new TriggerCoordinator({ onFire: async () => {} })
    const reg = c.register({
      kind: 'poll',
      id: 't',
      workflowId: 'wf',
      everyMs: 50,
      sourceFnId: 'missing',
    })
    expect(reg.lastError).toContain('poll source not registered')
    await c.stop()
  })
})
