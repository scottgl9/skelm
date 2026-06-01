import type { ChatUiConfig } from '@skelm/integration-sdk'
import { describe, expect, it } from 'vitest'
import {
  type ChatUiFrontend,
  type ChatUiFrontendIo,
  ChatUiIntegration,
  type ChatUiMessageInput,
  createRemoteTriggerSource,
} from '../src/chatui.js'

function makeChatUi(): ChatUiIntegration {
  const config: ChatUiConfig = {
    id: 'chatui',
    name: 'Chat UI',
    enabled: true,
    credentials: {},
  }
  return new ChatUiIntegration(config)
}

/** A frontend test double: records render/close and exposes the bridge io. */
function fakeFrontend() {
  const rendered: Array<{ reply: string; payload: ChatUiMessageInput }> = []
  let io: ChatUiFrontendIo | null = null
  let closed = false
  const factory = (bridge: ChatUiFrontendIo): ChatUiFrontend => {
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

describe('ChatUiIntegration (mechanism)', () => {
  it('initializes without credentials and reports healthy', async () => {
    const chatui = makeChatUi()
    await expect(chatui.init()).resolves.toBeUndefined()
    await expect(chatui.healthCheck()).resolves.toBe(true)
    expect(chatui.capabilities.canTrigger).toBe(true)
    expect(chatui.id).toBe('chatui')
  })

  it('builds the frontend on start and fires onMessage per submitted line', async () => {
    const chatui = makeChatUi()
    await chatui.init()
    const fe = fakeFrontend()
    const source = chatui.createTriggerSource({ frontend: fe.factory })

    const seen: ChatUiMessageInput[] = []
    source.start({ onMessage: async (p) => void seen.push(p as ChatUiMessageInput) })

    fe.submit('hello')
    fe.submit('   ') // blank → ignored
    fe.submit('world')
    await tick()

    expect(seen.map((s) => s.text)).toEqual(['hello', 'world'])
    expect(seen.map((s) => s.seq)).toEqual([1, 2])
    expect(seen[0]?.sessionId).toBe('chatui')
    expect(seen[0]?.from).toBe('you')
    await source.stop()
  })

  it('honors sessionId and from options', async () => {
    const chatui = makeChatUi()
    await chatui.init()
    const fe = fakeFrontend()
    const source = chatui.createTriggerSource({
      frontend: fe.factory,
      sessionId: 'sess-42',
      from: 'alice',
    })
    const seen: ChatUiMessageInput[] = []
    source.start({ onMessage: async (p) => void seen.push(p as ChatUiMessageInput) })

    fe.submit('hi')
    await tick()

    expect(seen[0]).toMatchObject({ sessionId: 'sess-42', from: 'alice', text: 'hi', seq: 1 })
    await source.stop()
  })

  it('onResult renders output.reply to the frontend', async () => {
    const chatui = makeChatUi()
    await chatui.init()
    const fe = fakeFrontend()
    const source = chatui.createTriggerSource({ frontend: fe.factory })
    source.start({ onMessage: async () => {} })

    const payload: ChatUiMessageInput = { sessionId: 'chatui', from: 'you', text: 'ping', seq: 1 }
    await source.onResult?.(payload, { reply: 'pong' })

    expect(fe.rendered).toEqual([{ reply: 'pong', payload }])
    await source.stop()
  })

  it('onResult renders nothing for a missing or empty reply', async () => {
    const chatui = makeChatUi()
    await chatui.init()
    const fe = fakeFrontend()
    const source = chatui.createTriggerSource({ frontend: fe.factory })
    source.start({ onMessage: async () => {} })

    const payload: ChatUiMessageInput = { sessionId: 'chatui', from: 'you', text: 'x', seq: 1 }
    await source.onResult?.(payload, { reply: '' })
    await source.onResult?.(payload, {})
    await source.onResult?.(payload, undefined)

    expect(fe.rendered).toHaveLength(0)
    await source.stop()
  })

  it('end-to-end: a submitted line fires the (echo) handler and renders the reply', async () => {
    const chatui = makeChatUi()
    await chatui.init()
    const fe = fakeFrontend()
    const source = chatui.createTriggerSource({ frontend: fe.factory })

    // Echo handler that drives onResult exactly like the gateway would.
    source.start({
      onMessage: async (payload) => {
        const msg = payload as ChatUiMessageInput
        await source.onResult?.(payload, { reply: `echo: ${msg.text}` })
      },
    })

    fe.submit('cake')
    await tick()

    expect(fe.rendered.map((r) => r.reply)).toEqual(['echo: cake'])
    await source.stop()
  })

  it('stop() closes the frontend', async () => {
    const chatui = makeChatUi()
    await chatui.init()
    const fe = fakeFrontend()
    const source = chatui.createTriggerSource({ frontend: fe.factory })
    source.start({ onMessage: async () => {} })
    expect(fe.isClosed()).toBe(false)
    await source.stop()
    expect(fe.isClosed()).toBe(true)
  })

  it('postReply:false does not register an onResult hook', async () => {
    const chatui = makeChatUi()
    await chatui.init()
    const fe = fakeFrontend()
    const source = chatui.createTriggerSource({ frontend: fe.factory, postReply: false })
    expect(source.onResult).toBeUndefined()
  })
})

describe('createRemoteTriggerSource', () => {
  it('submit fires onMessage and resolves with the runId from the first run event', async () => {
    const src = createRemoteTriggerSource()
    const fired: ChatUiMessageInput[] = []
    src.start({
      onMessage: async (p) => {
        fired.push(p as ChatUiMessageInput)
        // Simulate the dispatcher forwarding the first run event to onEvent.
        src.onEvent(p, { type: 'run.started', runId: 'run-1', at: 0 })
      },
    })
    const { runId } = await src.submit({ sessionId: 's1', text: 'hi' })
    expect(runId).toBe('run-1')
    expect(fired[0]).toMatchObject({ sessionId: 's1', text: 'hi', from: 'you', seq: 1 })
  })

  it('defaults to the tui transport and carries an optional frontend', () => {
    const factory = () => ({ render: () => {} })
    const src = createRemoteTriggerSource({ frontend: factory })
    expect(src.transport).toBe('tui')
    expect(src.frontend).toBe(factory)
  })

  it('selects the web transport and carries no frontend', () => {
    const src = createRemoteTriggerSource({ transport: 'web' })
    expect(src.transport).toBe('web')
    expect(src.frontend).toBeUndefined()
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
