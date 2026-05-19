import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  class MiniEmitter {
    private listeners = new Map<string, Listener[]>()

    on(event: string, listener: Listener): this {
      const existing = this.listeners.get(event) ?? []
      existing.push(listener)
      this.listeners.set(event, existing)
      return this
    }

    emit(event: string, ...args: unknown[]): boolean {
      const listeners = this.listeners.get(event) ?? []
      for (const listener of listeners) listener(...args)
      return listeners.length > 0
    }
  }

  class MockWebSocket extends MiniEmitter {
    static CONNECTING = 0
    static OPEN = 1
    static instances: MockWebSocket[] = []

    readonly sent: string[] = []
    readyState = MockWebSocket.OPEN

    constructor(public readonly url: string) {
      super()
      MockWebSocket.instances.push(this)
    }

    send(data: string): void {
      this.sent.push(data)
    }

    close(): void {
      this.readyState = 3
      this.emit('close')
    }
  }

  return {
    MiniEmitter,
    MockWebSocket,
    httpsGetMock: vi.fn(),
    slackSocketUrls: [] as string[],
  }
})

mockState.httpsGetMock.mockImplementation(
  (
    _: string,
    __: unknown,
    cb: (res: {
      statusCode?: number
      setEncoding: (encoding: string) => void
      resume: () => void
      on: (event: string, listener: (...args: unknown[]) => void) => unknown
      emit: (event: string, ...args: unknown[]) => boolean
    }) => void,
  ) => {
    const req = new mockState.MiniEmitter() as mockState.MiniEmitter & { destroy: () => void }
    req.destroy = () => {}

    const res = new mockState.MiniEmitter() as mockState.MiniEmitter & {
      statusCode?: number
      setEncoding: (encoding: string) => void
      resume: () => void
    }
    res.statusCode = 200
    res.setEncoding = () => {}
    res.resume = () => {}

    queueMicrotask(() => {
      cb(res)
      const url = mockState.slackSocketUrls.shift() ?? 'wss://slack.test/socket'
      res.emit('data', JSON.stringify({ ok: true, url }))
      res.emit('end')
    })

    return req
  },
)

vi.mock('ws', () => ({
  default: mockState.MockWebSocket,
}))

vi.mock('node:https', () => ({
  get: mockState.httpsGetMock,
}))

import { EventSourceManager } from '../src/triggers/event-source-manager.js'

describe('EventSourceManager socket-mode sources', () => {
  beforeEach(() => {
    mockState.MockWebSocket.instances = []
    mockState.slackSocketUrls.length = 0
    mockState.httpsGetMock.mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('handles Discord hello/identify, filters events, and reconnects on close', async () => {
    const payloads: unknown[] = []
    const manager = new EventSourceManager(
      {
        kind: 'event-source',
        id: 'discord-trigger',
        workflowId: 'wf',
        source: 'discord',
        options: {
          token: 'Bot abc',
          intents: 513,
          events: ['MESSAGE_CREATE'],
          reconnectDelayMs: 5,
        },
      },
      (payload) => void payloads.push(payload),
    )

    manager.start()

    expect(mockState.MockWebSocket.instances).toHaveLength(1)
    const ws = mockState.MockWebSocket.instances[0]
    ws.emit('open')
    ws.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 50 } }))

    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0] ?? '')).toMatchObject({
      op: 2,
      d: {
        token: 'Bot abc',
        intents: 513,
        properties: {
          browser: 'skelm',
          device: 'skelm',
        },
      },
    })

    ws.emit('message', JSON.stringify({ op: 0, t: 'GUILD_CREATE', d: { id: 'guild-1' } }))
    ws.emit('message', JSON.stringify({ op: 0, s: 42, t: 'MESSAGE_CREATE', d: { id: 'msg-1' } }))
    expect(payloads).toEqual([{ t: 'MESSAGE_CREATE', d: { id: 'msg-1' } }])

    await vi.advanceTimersByTimeAsync(50)
    expect(JSON.parse(ws.sent[1] ?? '')).toEqual({ op: 1, d: 42 })

    ws.emit('close')
    await vi.advanceTimersByTimeAsync(5)
    expect(mockState.MockWebSocket.instances).toHaveLength(2)

    manager.stop()
  })

  it('handles Slack socket mode bootstrap, acks envelopes, filters events, and reconnects on close', async () => {
    mockState.slackSocketUrls.push('wss://slack.test/socket-1', 'wss://slack.test/socket-2')
    const payloads: unknown[] = []
    const manager = new EventSourceManager(
      {
        kind: 'event-source',
        id: 'slack-trigger',
        workflowId: 'wf',
        source: 'slack',
        options: {
          appToken: 'xapp-123',
          events: ['message'],
          reconnectDelayMs: 5,
        },
      },
      (payload) => void payloads.push(payload),
    )

    manager.start()
    await flushMicrotasks()

    expect(mockState.httpsGetMock).toHaveBeenCalledTimes(1)
    expect(mockState.MockWebSocket.instances).toHaveLength(1)
    const ws = mockState.MockWebSocket.instances[0]

    ws.emit('message', JSON.stringify({ type: 'hello' }))
    ws.emit(
      'message',
      JSON.stringify({
        type: 'events_api',
        envelope_id: 'env-1',
        payload: { event: { type: 'message' } },
      }),
    )
    ws.emit(
      'message',
      JSON.stringify({
        type: 'events_api',
        envelope_id: 'env-2',
        payload: { event: { type: 'reaction_added' } },
      }),
    )

    expect(ws.sent).toEqual([
      JSON.stringify({ envelope_id: 'env-1' }),
      JSON.stringify({ envelope_id: 'env-2' }),
    ])
    expect(payloads).toEqual([
      {
        type: 'events_api',
        envelope_id: 'env-1',
        payload: { event: { type: 'message' } },
      },
    ])

    ws.emit('close')
    await vi.advanceTimersByTimeAsync(5)
    await flushMicrotasks()
    expect(mockState.httpsGetMock).toHaveBeenCalledTimes(2)
    expect(mockState.MockWebSocket.instances).toHaveLength(2)

    manager.stop()
  })
})

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
