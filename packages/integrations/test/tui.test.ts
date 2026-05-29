import type { TuiConfig } from '@skelm/integration-sdk'
import { describe, expect, it } from 'vitest'
import {
  type TuiFrontend,
  type TuiFrontendIo,
  TuiIntegration,
  type TuiMessageInput,
  createRemoteTriggerSource,
} from '../src/tui.js'

function makeTui(): TuiIntegration {
  const config: TuiConfig = {
    id: 'tui',
    name: 'Terminal UI',
    enabled: true,
    credentials: {},
  }
  return new TuiIntegration(config)
}

/** A frontend test double: records render/close and exposes the bridge io. */
function fakeFrontend() {
  const rendered: Array<{ reply: string; payload: TuiMessageInput }> = []
  let io: TuiFrontendIo | null = null
  let closed = false
  const factory = (bridge: TuiFrontendIo): TuiFrontend => {
    io = bridge
    return {
      render: (reply, payload) => rendered.push({ reply, payload }),
      close: () => {
        closed = true
      },
    }
  }
  return {
    factory,
    rendered,
    submit: (text: string) => io?.submit(text),
    isClosed: () => closed,
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('TuiIntegration (mechanism)', () => {
  it('initializes without credentials and reports healthy', async () => {
    const tui = makeTui()
    await expect(tui.init()).resolves.toBeUndefined()
    await expect(tui.healthCheck()).resolves.toBe(true)
    expect(tui.capabilities.canTrigger).toBe(true)
  })

  it('builds the frontend on start and fires onMessage per submitted line', async () => {
    const tui = makeTui()
    await tui.init()
    const fe = fakeFrontend()
    const source = tui.createTriggerSource({ frontend: fe.factory })

    const seen: TuiMessageInput[] = []
    source.start({ onMessage: async (p) => void seen.push(p as TuiMessageInput) })

    fe.submit('hello')
    fe.submit('   ') // blank → ignored
    fe.submit('world')
    await tick()

    expect(seen.map((s) => s.text)).toEqual(['hello', 'world'])
    expect(seen.map((s) => s.seq)).toEqual([1, 2])
    expect(seen[0]?.sessionId).toBe('tui')
    expect(seen[0]?.from).toBe('you')
    await source.stop()
  })

  it('honors sessionId and from options', async () => {
    const tui = makeTui()
    await tui.init()
    const fe = fakeFrontend()
    const source = tui.createTriggerSource({
      frontend: fe.factory,
      sessionId: 'sess-42',
      from: 'alice',
    })
    const seen: TuiMessageInput[] = []
    source.start({ onMessage: async (p) => void seen.push(p as TuiMessageInput) })

    fe.submit('hi')
    await tick()

    expect(seen[0]).toMatchObject({ sessionId: 'sess-42', from: 'alice', text: 'hi', seq: 1 })
    await source.stop()
  })

  it('onResult renders output.reply to the frontend', async () => {
    const tui = makeTui()
    await tui.init()
    const fe = fakeFrontend()
    const source = tui.createTriggerSource({ frontend: fe.factory })
    source.start({ onMessage: async () => {} })

    const payload: TuiMessageInput = { sessionId: 'tui', from: 'you', text: 'ping', seq: 1 }
    await source.onResult?.(payload, { reply: 'pong' })

    expect(fe.rendered).toEqual([{ reply: 'pong', payload }])
    await source.stop()
  })

  it('onResult renders nothing for a missing or empty reply', async () => {
    const tui = makeTui()
    await tui.init()
    const fe = fakeFrontend()
    const source = tui.createTriggerSource({ frontend: fe.factory })
    source.start({ onMessage: async () => {} })

    const payload: TuiMessageInput = { sessionId: 'tui', from: 'you', text: 'x', seq: 1 }
    await source.onResult?.(payload, { reply: '' })
    await source.onResult?.(payload, {})
    await source.onResult?.(payload, undefined)

    expect(fe.rendered).toHaveLength(0)
    await source.stop()
  })

  it('end-to-end: a submitted line fires the (echo) handler and renders the reply', async () => {
    const tui = makeTui()
    await tui.init()
    const fe = fakeFrontend()
    const source = tui.createTriggerSource({ frontend: fe.factory })

    // Echo handler that drives onResult exactly like the gateway would.
    source.start({
      onMessage: async (payload) => {
        const msg = payload as TuiMessageInput
        await source.onResult?.(payload, { reply: `echo: ${msg.text}` })
      },
    })

    fe.submit('cake')
    await tick()

    expect(fe.rendered.map((r) => r.reply)).toEqual(['echo: cake'])
    await source.stop()
  })

  it('stop() closes the frontend', async () => {
    const tui = makeTui()
    await tui.init()
    const fe = fakeFrontend()
    const source = tui.createTriggerSource({ frontend: fe.factory })
    source.start({ onMessage: async () => {} })
    expect(fe.isClosed()).toBe(false)
    await source.stop()
    expect(fe.isClosed()).toBe(true)
  })

  it('postReply:false does not register an onResult hook', async () => {
    const tui = makeTui()
    await tui.init()
    const fe = fakeFrontend()
    const source = tui.createTriggerSource({ frontend: fe.factory, postReply: false })
    expect(source.onResult).toBeUndefined()
  })
})

describe('createRemoteTriggerSource', () => {
  it('submit fires onMessage and resolves with the runId from the first run event', async () => {
    const src = createRemoteTriggerSource()
    const fired: TuiMessageInput[] = []
    src.start({
      onMessage: async (p) => {
        fired.push(p as TuiMessageInput)
        // Simulate the dispatcher forwarding the first run event to onEvent.
        src.onEvent(p, { type: 'run.started', runId: 'run-1', at: 0 })
      },
    })
    const { runId } = await src.submit({ sessionId: 's1', text: 'hi' })
    expect(runId).toBe('run-1')
    expect(fired[0]).toMatchObject({ sessionId: 's1', text: 'hi', from: 'you', seq: 1 })
  })

  it('exposes the tui transport marker and an optional frontend', () => {
    const factory = () => ({ render: () => {} })
    const src = createRemoteTriggerSource({ frontend: factory })
    expect(src.transport).toBe('tui')
    expect(src.frontend).toBe(factory)
  })

  it('rejects when the run never starts within the timeout', async () => {
    const src = createRemoteTriggerSource({ startTimeoutMs: 10 })
    src.start({ onMessage: async () => {} })
    await expect(src.submit({ sessionId: 's', text: 'x' })).rejects.toThrow(/did not start/)
  })

  it('stop rejects pending submits', async () => {
    const src = createRemoteTriggerSource()
    src.start({ onMessage: async () => {} })
    const pending = src.submit({ sessionId: 's', text: 'x' })
    src.stop()
    await expect(pending).rejects.toThrow(/stopped/)
  })
})
