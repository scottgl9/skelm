import type { Connection } from '@skelm/integration-sdk'
import { describe, expect, it } from 'vitest'
import {
  MatrixConversationAdapter,
  type MatrixTransport,
  normalizeMatrixInbound,
} from '../src/matrix-adapter.js'

function connection(): Connection {
  return {
    id: 'conn-mx',
    integrationId: 'matrix',
    credentialSchemaId: 'matrix',
    credentials: [{ kind: 'credential-ref', secretName: 'MATRIX_ACCESS_TOKEN' }],
    metadata: { userId: '@bot:example.org' },
  }
}

function transportWith(result: Record<string, unknown> = { event_id: '$evt1' }): {
  transport: MatrixTransport
  calls: Array<[string, string, Record<string, unknown> | undefined]>
} {
  const calls: Array<[string, string, Record<string, unknown> | undefined]> = []
  const transport: MatrixTransport = async (method, path, body) => {
    calls.push([method, path, body as Record<string, unknown> | undefined])
    return result
  }
  return { transport, calls }
}

describe('MatrixConversationAdapter', () => {
  it('advertises only ops it implements (buttons/slashCommands false)', () => {
    const adapter = new MatrixConversationAdapter(transportWith().transport)
    const c = adapter.capabilities
    expect(c.provider).toBe('matrix')
    expect(c.buttons).toBe(false)
    expect(c.slashCommands).toBe(false)
    expect((adapter as { registerCommands?: unknown }).registerCommands).toBeUndefined()
    expect(c.editMessage).toBe(true)
    expect(typeof adapter.editMessage).toBe('function')
    expect(c.reactions).toBe(true)
    expect(typeof adapter.addReaction).toBe('function')
    expect(c.replyInThread).toBe(true)
    expect(typeof adapter.replyInThread).toBe('function')
    expect(c.media).toEqual(['image', 'file', 'video'])
    expect(c.mediaSources).toEqual(['url'])
    expect(typeof adapter.sendImage).toBe('function')
    expect(typeof adapter.sendFile).toBe('function')
    expect(typeof adapter.sendVideo).toBe('function')
    expect((adapter as { sendVoice?: unknown }).sendVoice).toBeUndefined()
  })

  it('sendMessage PUTs m.room.message and returns the event id', async () => {
    const { transport, calls } = transportWith()
    const adapter = new MatrixConversationAdapter(transport)
    const ref = await adapter.sendMessage({ target: { conversationId: '!r:e.org' }, text: 'hi' })
    expect(calls[0][0]).toBe('PUT')
    expect(calls[0][1]).toContain(`/rooms/${encodeURIComponent('!r:e.org')}/send/m.room.message/`)
    expect(calls[0][2]).toMatchObject({ msgtype: 'm.text', body: 'hi' })
    expect(ref.messageId).toBe('$evt1')
  })

  it('editMessage uses m.replace with m.new_content', async () => {
    const { transport, calls } = transportWith()
    const adapter = new MatrixConversationAdapter(transport)
    await adapter.editMessage(
      { messageId: '$old', target: { conversationId: '!r:e.org' } },
      { target: { conversationId: '!r:e.org' }, text: 'fixed' },
    )
    expect(calls[0][2]).toMatchObject({
      'm.new_content': { msgtype: 'm.text', body: 'fixed' },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$old' },
    })
  })

  it('addReaction PUTs an m.annotation m.reaction event', async () => {
    const { transport, calls } = transportWith()
    const adapter = new MatrixConversationAdapter(transport)
    await adapter.addReaction({ messageId: '$m', target: { conversationId: '!r:e.org' } }, '👍')
    expect(calls[0][1]).toContain('/send/m.reaction/')
    expect(calls[0][2]).toMatchObject({
      'm.relates_to': { rel_type: 'm.annotation', event_id: '$m', key: '👍' },
    })
  })

  it('replyInThread relates via m.thread', async () => {
    const { transport, calls } = transportWith()
    const adapter = new MatrixConversationAdapter(transport)
    await adapter.replyInThread(
      { messageId: '$root', target: { conversationId: '!r:e.org' } },
      { target: { conversationId: '!r:e.org' }, text: 'reply' },
    )
    expect(calls[0][2]).toMatchObject({
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
    })
  })

  it('rejects inline-only media sends', async () => {
    const adapter = new MatrixConversationAdapter(transportWith().transport)
    await expect(
      adapter.sendFile(
        { conversationId: '!r:e.org' },
        { kind: 'file', contentType: 'text/plain', data: 'aGVsbG8=' },
      ),
    ).rejects.toThrow(/MediaAttachment\.url/)
  })

  it('connect rejects a leaked accessToken value', async () => {
    const adapter = new MatrixConversationAdapter(transportWith().transport)
    const tainted = { ...connection(), accessToken: 'syt_leaked' } as unknown as Connection
    await expect(adapter.connect(tainted)).rejects.toThrow(/must not carry a secret value/)
  })

  it('connect accepts a reference-only connection', async () => {
    const adapter = new MatrixConversationAdapter(transportWith().transport)
    await expect(adapter.connect(connection())).resolves.toBeUndefined()
  })
})

describe('normalizeMatrixInbound', () => {
  it('normalizes a text message', () => {
    const ev = normalizeMatrixInbound({
      type: 'm.room.message',
      event_id: '$e1',
      room_id: '!r:e.org',
      sender: '@a:e.org',
      origin_server_ts: 1700,
      content: { msgtype: 'm.text', body: 'hello' },
    })
    expect(ev).toMatchObject({
      provider: 'matrix',
      type: 'message',
      text: 'hello',
      messageId: '$e1',
      target: { conversationId: '!r:e.org', userId: '@a:e.org' },
    })
  })

  it('normalizes an m.replace edit', () => {
    const ev = normalizeMatrixInbound({
      type: 'm.room.message',
      event_id: '$e2',
      room_id: '!r:e.org',
      sender: '@a:e.org',
      content: {
        msgtype: 'm.text',
        body: '* fixed',
        'm.new_content': { body: 'fixed' },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$e1' },
      },
    })
    expect(ev).toMatchObject({ type: 'edit', text: 'fixed', messageId: '$e1' })
  })

  it('normalizes a thread reply with threadId', () => {
    const ev = normalizeMatrixInbound({
      type: 'm.room.message',
      event_id: '$e3',
      room_id: '!r:e.org',
      sender: '@a:e.org',
      content: {
        msgtype: 'm.text',
        body: 'in thread',
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
      },
    })
    expect(ev?.type).toBe('message')
    expect(ev?.target.threadId).toBe('$root')
  })

  it('normalizes an m.reaction', () => {
    const ev = normalizeMatrixInbound({
      type: 'm.reaction',
      event_id: '$e4',
      room_id: '!r:e.org',
      sender: '@a:e.org',
      content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$e1', key: '🔥' } },
    })
    expect(ev).toMatchObject({ type: 'reaction', reaction: '🔥', messageId: '$e1' })
  })

  it('normalizes a redaction to a delete', () => {
    const ev = normalizeMatrixInbound({
      type: 'm.room.redaction',
      event_id: '$e5',
      room_id: '!r:e.org',
      sender: '@a:e.org',
      redacts: '$e1',
    })
    expect(ev).toMatchObject({ type: 'delete', messageId: '$e1' })
  })

  it('returns null for an unsupported event', () => {
    expect(
      normalizeMatrixInbound({ type: 'm.room.member', event_id: '$x', room_id: '!r' }),
    ).toBeNull()
    expect(normalizeMatrixInbound({})).toBeNull()
  })
})

describe('normalizeMatrixInbound — robustness', () => {
  it('returns null for null/undefined/non-object events (no throw)', () => {
    for (const bad of [null, undefined, 'str', 42, []]) {
      expect(normalizeMatrixInbound(bad)).toBeNull()
    }
  })
})
