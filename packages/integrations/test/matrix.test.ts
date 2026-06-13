import type { MatrixConfig } from '@skelm/integration-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MatrixIntegration, matrixSyncToInputs } from '../src/matrix.js'

const homeserverUrl = 'https://matrix.example.org'
const accessToken = 'syt_bot_secret_token'
const botUserId = '@bot:example.org'

function makeConfig(overrides: Partial<MatrixConfig['credentials']> = {}): MatrixConfig {
  return {
    id: 'matrix',
    name: 'Matrix',
    enabled: true,
    credentials: { homeserverUrl, accessToken, ...overrides },
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textMessageEvent(eventId: string, sender: string, body: string): Record<string, unknown> {
  return {
    type: 'm.room.message',
    event_id: eventId,
    sender,
    origin_server_ts: 1700000000,
    content: { msgtype: 'm.text', body },
  }
}

describe('MatrixIntegration', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects missing access token', async () => {
    const cfg = makeConfig()
    cfg.credentials.accessToken = ''
    const mx = new MatrixIntegration(cfg, { fetch: fetchMock as unknown as typeof fetch })
    await expect(mx.init()).rejects.toThrow(/accessToken required/)
  })

  it('rejects missing homeserver url', async () => {
    const cfg = makeConfig()
    cfg.credentials.homeserverUrl = ''
    const mx = new MatrixIntegration(cfg, { fetch: fetchMock as unknown as typeof fetch })
    await expect(mx.init()).rejects.toThrow(/homeserverUrl required/)
  })

  it('initializes with valid credentials', async () => {
    const mx = new MatrixIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await expect(mx.init()).resolves.toBeUndefined()
  })

  it('whoami GETs /account/whoami with a bearer token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user_id: botUserId, device_id: 'DEV1' }))
    const mx = new MatrixIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await mx.init()
    const who = await mx.whoami()
    expect(who).toEqual({ userId: botUserId, deviceId: 'DEV1' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`${homeserverUrl}/_matrix/client/v3/account/whoami`)
    expect(init?.method).toBe('GET')
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${accessToken}`)
  })

  it('healthCheck returns true when whoami succeeds and false when it fails', async () => {
    const mx = new MatrixIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await mx.init()
    fetchMock.mockResolvedValueOnce(jsonResponse({ user_id: botUserId }))
    expect(await mx.healthCheck()).toBe(true)
    fetchMock.mockResolvedValueOnce(jsonResponse({ errcode: 'M_UNKNOWN_TOKEN' }, 401))
    expect(await mx.healthCheck()).toBe(false)
  })

  it('sendMessage PUTs to the room send endpoint and returns the event id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ event_id: '$abc:example.org' }))
    const mx = new MatrixIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await mx.init()
    const out = await mx.sendMessage({ roomId: '!room:example.org', body: 'hi' })
    expect(out.eventId).toBe('$abc:example.org')

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(
      '/_matrix/client/v3/rooms/!room%3Aexample.org/send/m.room.message/',
    )
    expect(init?.method).toBe('PUT')
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({ msgtype: 'm.text', body: 'hi' })
  })

  it('sendMessage with replyToEventId attaches an m.in_reply_to relation', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ event_id: '$resp:example.org' }))
    const mx = new MatrixIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await mx.init()
    await mx.sendMessage({
      roomId: '!r:example.org',
      body: 'pong',
      replyToEventId: '$evt:example.org',
    })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toEqual({
      msgtype: 'm.text',
      body: 'pong',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$evt:example.org' } },
    })
  })

  it('editMessage PUTs an m.replace edit relation', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ event_id: '$edit:example.org' }))
    const mx = new MatrixIntegration(makeConfig(), { fetch: fetchMock as unknown as typeof fetch })
    await mx.init()
    await mx.editMessage({
      roomId: '!r:example.org',
      eventId: '$orig:example.org',
      body: 'updated',
    })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toEqual({
      msgtype: 'm.text',
      body: ' * updated',
      'm.new_content': { msgtype: 'm.text', body: 'updated' },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$orig:example.org' },
    })
  })

  it('streamReplies: opens a placeholder, edits on deltas, and commits the final reply', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ event_id: '$stream:example.org' }))
    const mx = new MatrixIntegration(makeConfig(), { fetch: fetchMock as unknown as typeof fetch })
    await mx.init()
    const src = mx.createTriggerSource({ streamReplies: true, streamThrottleMs: 0 })
    const input = {
      eventId: '$inbound:example.org',
      roomId: '!r:example.org',
      sender: '@u:example.org',
      body: 'hi',
      date: 1,
    }

    await src.onEvent?.(input, { type: 'step.partial', delta: 'Hel' })
    await src.onEvent?.(input, { type: 'step.partial', delta: 'lo' })
    await src.onResult?.(input, { reply: 'Hello world' })

    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body)))
    // 1) placeholder send with the first delta, threaded as a reply
    expect(bodies[0]).toEqual({
      msgtype: 'm.text',
      body: 'Hel',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$inbound:example.org' } },
    })
    // 2) edit with the accumulated text
    expect(bodies[1]['m.new_content']).toEqual({ msgtype: 'm.text', body: 'Hello' })
    expect(bodies[1]['m.relates_to'].rel_type).toBe('m.replace')
    // 3) final commit edits the same message (no duplicate send)
    expect(bodies[2]['m.new_content']).toEqual({ msgtype: 'm.text', body: 'Hello world' })
    expect(bodies[2]['m.relates_to'].rel_type).toBe('m.replace')
    expect(fetchMock.mock.calls).toHaveLength(3)
  })

  it('streamReplies: concurrent deltas during the first send post only one placeholder', async () => {
    // The gateway dispatches run events as `void onEvent(...)` with no
    // back-pressure (gateway/src/triggers/dispatcher.ts), so deltas can arrive
    // while the first placeholder send is still in flight. Hold that first send
    // open, fire a second delta, and assert only ONE reply-threaded placeholder
    // is posted — not one per racing delta.
    let releaseFirst: (r: Response) => void = () => {}
    const firstSend = new Promise<Response>((res) => {
      releaseFirst = res
    })
    fetchMock
      .mockReturnValueOnce(firstSend)
      .mockResolvedValue(jsonResponse({ event_id: '$stream:example.org' }))
    const mx = new MatrixIntegration(makeConfig(), { fetch: fetchMock as unknown as typeof fetch })
    await mx.init()
    const src = mx.createTriggerSource({ streamReplies: true, streamThrottleMs: 0 })
    const input = {
      eventId: '$inbound:example.org',
      roomId: '!r:example.org',
      sender: '@u:example.org',
      body: 'hi',
      date: 1,
    }

    // Fire two deltas WITHOUT awaiting the first — both run before the
    // placeholder send resolves, mirroring the unbuffered gateway dispatch.
    const p1 = src.onEvent?.(input, { type: 'step.partial', delta: 'Hel' })
    const p2 = src.onEvent?.(input, { type: 'step.partial', delta: 'lo' })
    releaseFirst(jsonResponse({ event_id: '$stream:example.org' }))
    await Promise.all([p1, p2])

    const placeholderSends = fetchMock.mock.calls
      .map((c) => JSON.parse(String(c[1]?.body)))
      .filter((b) => b['m.relates_to']?.['m.in_reply_to'] !== undefined)
    expect(placeholderSends).toHaveLength(1)
  })

  it('without streamReplies, posts a single final reply and has no onEvent hook', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ event_id: '$x:example.org' }))
    const mx = new MatrixIntegration(makeConfig(), { fetch: fetchMock as unknown as typeof fetch })
    await mx.init()
    const src = mx.createTriggerSource({})
    expect(src.onEvent).toBeUndefined()
    const input = {
      eventId: '$in:example.org',
      roomId: '!r:example.org',
      sender: '@u:example.org',
      body: 'hi',
      date: 1,
    }
    await src.onResult?.(input, { reply: 'final' })
    expect(fetchMock.mock.calls).toHaveLength(1)
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toEqual({
      msgtype: 'm.text',
      body: 'final',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$in:example.org' } },
    })
  })

  it('sendNotification throws without a roomId and sends with one', async () => {
    const mx = new MatrixIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await mx.init()
    await expect(mx.sendNotification('hi')).rejects.toThrow(/roomId/)

    fetchMock.mockResolvedValueOnce(jsonResponse({ event_id: '$x:example.org' }))
    await mx.sendNotification('hello', { roomId: '!r:example.org' })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.body).toBe('hello')
  })

  it('throws on a Matrix error response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ errcode: 'M_FORBIDDEN', error: 'Not allowed' }, 403),
    )
    const mx = new MatrixIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await mx.init()
    await expect(mx.sendMessage({ roomId: '!r:example.org', body: 'x' })).rejects.toThrow(
      /Not allowed/,
    )
  })

  it('eventToRunInput maps an m.room.message event to a MatrixMessageTrigger', async () => {
    const mx = new MatrixIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await mx.init()
    const out = await mx.eventToRunInput({
      type: 'm.room.message',
      event_id: '$e:example.org',
      room_id: '!room:example.org',
      sender: '@alice:example.org',
      origin_server_ts: 1700000000,
      content: { msgtype: 'm.text', body: 'hello bot' },
    })
    expect(out).toEqual({
      trigger: {
        type: 'matrix-message',
        eventId: '$e:example.org',
        roomId: '!room:example.org',
        sender: '@alice:example.org',
        body: 'hello bot',
        date: 1700000000,
      },
    })
  })

  it('eventToRunInput returns null for non-text / non-message events', async () => {
    const mx = new MatrixIntegration(makeConfig(), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await mx.init()
    expect(await mx.eventToRunInput({ type: 'm.room.member' })).toBeNull()
    expect(
      await mx.eventToRunInput({
        type: 'm.room.message',
        event_id: '$e',
        room_id: '!r',
        sender: '@a',
        content: { msgtype: 'm.image', body: 'pic.png' },
      }),
    ).toBeNull()
  })

  it('matrixSyncToInputs extracts text messages and skips own / non-text / encrypted', () => {
    const sync = {
      next_batch: 's1',
      rooms: {
        join: {
          '!room:example.org': {
            timeline: {
              events: [
                textMessageEvent('$1', '@alice:example.org', 'hi there'),
                textMessageEvent('$2', botUserId, 'my own echo'),
                {
                  type: 'm.room.message',
                  event_id: '$3',
                  sender: '@alice:example.org',
                  content: { msgtype: 'm.image', body: 'pic.png' },
                },
                {
                  type: 'm.room.encrypted',
                  event_id: '$4',
                  sender: '@alice:example.org',
                  content: {},
                },
              ],
            },
          },
        },
      },
    }
    expect(matrixSyncToInputs(sync, botUserId)).toEqual([
      {
        roomId: '!room:example.org',
        eventId: '$1',
        sender: '@alice:example.org',
        body: 'hi there',
      },
    ])
  })

  it('matrixSyncToInputs returns [] when there are no joined rooms', () => {
    expect(matrixSyncToInputs({ next_batch: 's0' })).toEqual([])
  })

  it('createTriggerSource syncs and emits one onMessage per text message, then stops', async () => {
    // First sync: two text messages from a non-bot sender.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        next_batch: 's1',
        rooms: {
          join: {
            '!room:example.org': {
              timeline: {
                events: [
                  textMessageEvent('$10', '@alice:example.org', 'one'),
                  textMessageEvent('$11', '@alice:example.org', 'two'),
                ],
              },
            },
          },
        },
      }),
    )
    // Subsequent syncs: empty until stop.
    fetchMock.mockImplementation(
      () => new Promise((res) => setTimeout(() => res(jsonResponse({ next_batch: 's2' })), 5)),
    )

    // userId in credentials ⇒ no /whoami round trip needed.
    const mx = new MatrixIntegration(makeConfig({ userId: botUserId }), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await mx.init()
    const source = mx.createTriggerSource({ dropPending: false, syncTimeoutMs: 0 })

    const seen: Array<{ body: string }> = []
    source.start({
      onMessage: async (payload) => {
        seen.push(payload as { body: string })
      },
    })
    await new Promise((r) => setTimeout(r, 30))
    await source.stop()

    expect(seen.map((s) => s.body)).toEqual(['one', 'two'])
  })

  it('createTriggerSource never fires for the bot’s own messages (no echo loop)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        next_batch: 's1',
        rooms: {
          join: {
            '!room:example.org': {
              timeline: { events: [textMessageEvent('$20', botUserId, 'echo of my reply')] },
            },
          },
        },
      }),
    )
    fetchMock.mockImplementation(
      () => new Promise((res) => setTimeout(() => res(jsonResponse({ next_batch: 's2' })), 5)),
    )

    const mx = new MatrixIntegration(makeConfig({ userId: botUserId }), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await mx.init()
    const source = mx.createTriggerSource({ dropPending: false, syncTimeoutMs: 0 })

    const seen: unknown[] = []
    source.start({ onMessage: async (p) => void seen.push(p) })
    await new Promise((r) => setTimeout(r, 30))
    await source.stop()

    expect(seen).toHaveLength(0)
  })

  it('createTriggerSource drops messages from non-allowlisted rooms/users', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        next_batch: 's1',
        rooms: {
          join: {
            '!room:example.org': {
              timeline: {
                events: [
                  textMessageEvent('$30', '@alice:example.org', 'allowed'),
                  textMessageEvent('$31', '@mallory:example.org', 'blocked-user'),
                ],
              },
            },
            '!other:example.org': {
              timeline: {
                events: [textMessageEvent('$32', '@alice:example.org', 'blocked-room')],
              },
            },
          },
        },
      }),
    )
    fetchMock.mockImplementation(
      () => new Promise((res) => setTimeout(() => res(jsonResponse({ next_batch: 's2' })), 5)),
    )

    const mx = new MatrixIntegration(makeConfig({ userId: botUserId }), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await mx.init()
    const source = mx.createTriggerSource({
      dropPending: false,
      syncTimeoutMs: 0,
      allowedRoomIds: ['!room:example.org'],
      allowedUsers: ['@alice:example.org'],
    })

    const seen: Array<{ body: string }> = []
    source.start({ onMessage: async (p) => void seen.push(p as { body: string }) })
    await new Promise((r) => setTimeout(r, 30))
    await source.stop()

    // Only the message matching BOTH allowlists fires.
    expect(seen.map((s) => s.body)).toEqual(['allowed'])
  })

  it('createTriggerSource onResult posts output.reply via sendMessage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ event_id: '$reply:example.org' }))
    const mx = new MatrixIntegration(makeConfig({ userId: botUserId }), {
      fetch: fetchMock as unknown as typeof fetch,
    })
    await mx.init()
    const source = mx.createTriggerSource({ dropPending: false, postReply: true })

    await source.onResult?.(
      {
        roomId: '!r:example.org',
        eventId: '$evt:example.org',
        sender: '@u:example.org',
        body: 'hi',
      },
      { reply: 'pong' },
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/rooms/!r%3Aexample.org/send/m.room.message/')
    expect(init?.method).toBe('PUT')
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({
      msgtype: 'm.text',
      body: 'pong',
      'm.relates_to': { 'm.in_reply_to': { event_id: '$evt:example.org' } },
    })
  })
})
