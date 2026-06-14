import type { Connection } from '@skelm/integration-sdk'
import { describe, expect, it } from 'vitest'
import {
  TelegramConversationAdapter,
  type TelegramTransport,
  normalizeTelegramInbound,
} from '../src/telegram-adapter.js'

function connection(): Connection {
  return {
    id: 'conn-tg',
    integrationId: 'telegram',
    credentialSchemaId: 'telegram',
    credentials: [{ kind: 'credential-ref', secretName: 'TELEGRAM_BOT_TOKEN' }],
  }
}

function transportWith(result: Record<string, unknown> = { message_id: 42 }): {
  transport: TelegramTransport
  calls: Array<[string, Record<string, unknown>]>
} {
  const calls: Array<[string, Record<string, unknown>]> = []
  const transport: TelegramTransport = async (method, body) => {
    calls.push([method, body as Record<string, unknown>])
    return result
  }
  return { transport, calls }
}

describe('TelegramConversationAdapter', () => {
  it('advertises capabilities backed by implementations', () => {
    const adapter = new TelegramConversationAdapter(transportWith().transport)
    const c = adapter.capabilities
    expect(c.provider).toBe('telegram')
    expect(c.editMessage).toBe(true)
    expect(typeof adapter.editMessage).toBe('function')
    expect(c.reactions).toBe(true)
    expect(typeof adapter.addReaction).toBe('function')
    expect(c.media).toEqual(['image', 'file', 'voice', 'video'])
    expect(c.mediaSources).toEqual(['url'])
    expect(typeof adapter.sendImage).toBe('function')
    expect(typeof adapter.sendFile).toBe('function')
    expect(typeof adapter.sendVoice).toBe('function')
    expect(typeof adapter.sendVideo).toBe('function')
    // replyInThread advertised false ⇒ op intentionally absent.
    expect(c.replyInThread).toBe(false)
    expect((adapter as { replyInThread?: unknown }).replyInThread).toBeUndefined()
  })

  it('sendMessage shapes a sendMessage body', async () => {
    const { transport, calls } = transportWith()
    const adapter = new TelegramConversationAdapter(transport)
    const ref = await adapter.sendMessage({
      target: { conversationId: '123' },
      text: 'hi',
      replyToMessageId: '7',
    })
    expect(calls[0]).toEqual([
      'sendMessage',
      { chat_id: '123', text: 'hi', reply_to_message_id: 7 },
    ])
    expect(ref.messageId).toBe('42')
  })

  it('inline keyboards ride providerOptions', async () => {
    const { transport, calls } = transportWith()
    const adapter = new TelegramConversationAdapter(transport)
    const reply_markup = { inline_keyboard: [[{ text: 'Go', callback_data: 'go' }]] }
    await adapter.sendMessage({
      target: { conversationId: '1' },
      text: 'pick',
      providerOptions: { reply_markup, parse_mode: 'MarkdownV2' },
    })
    expect(calls[0][1]).toMatchObject({
      chat_id: '1',
      text: 'pick',
      reply_markup,
      parse_mode: 'MarkdownV2',
    })
  })

  it('editMessage maps to editMessageText', async () => {
    const { transport, calls } = transportWith()
    const adapter = new TelegramConversationAdapter(transport)
    await adapter.editMessage(
      { messageId: '42', target: { conversationId: '1' } },
      { target: { conversationId: '1' }, text: 'new' },
    )
    expect(calls[0]).toEqual(['editMessageText', { chat_id: '1', message_id: 42, text: 'new' }])
  })

  it('addReaction maps to setMessageReaction', async () => {
    const { transport, calls } = transportWith()
    const adapter = new TelegramConversationAdapter(transport)
    await adapter.addReaction({ messageId: '42', target: { conversationId: '1' } }, '👍')
    expect(calls[0]).toEqual([
      'setMessageReaction',
      { chat_id: '1', message_id: 42, reaction: [{ type: 'emoji', emoji: '👍' }] },
    ])
  })

  it('sendImage maps to sendPhoto', async () => {
    const { transport, calls } = transportWith()
    const adapter = new TelegramConversationAdapter(transport)
    await adapter.sendImage(
      { conversationId: '1' },
      { kind: 'image', contentType: 'image/png', url: 'https://x/p.png' },
    )
    expect(calls[0]).toEqual(['sendPhoto', { chat_id: '1', photo: 'https://x/p.png' }])
  })

  it('rejects inline-only media sends', async () => {
    const adapter = new TelegramConversationAdapter(transportWith().transport)
    await expect(
      adapter.sendFile(
        { conversationId: '1' },
        { kind: 'file', contentType: 'text/plain', data: 'aGVsbG8=' },
      ),
    ).rejects.toThrow(/MediaAttachment\.url/)
  })

  it('connect rejects a leaked token value', async () => {
    const adapter = new TelegramConversationAdapter(transportWith().transport)
    const tainted = { ...connection(), token: '123:abc' } as unknown as Connection
    await expect(adapter.connect(tainted)).rejects.toThrow(/must not carry a secret value/)
  })
})

describe('normalizeTelegramInbound', () => {
  it('normalizes a plain message', () => {
    const ev = normalizeTelegramInbound({
      update_id: 1,
      message: { message_id: 10, chat: { id: 5 }, from: { id: 9 }, date: 1700000000, text: 'hi' },
    })
    expect(ev).toMatchObject({
      provider: 'telegram',
      type: 'message',
      text: 'hi',
      messageId: '10',
      target: { conversationId: '5', userId: '9' },
    })
    expect(ev?.at).toBe(1700000000 * 1000)
  })

  it('normalizes an edited_message to an edit', () => {
    const ev = normalizeTelegramInbound({
      update_id: 2,
      edited_message: { message_id: 10, chat: { id: 5 }, date: 1, text: 'fixed' },
    })
    expect(ev).toMatchObject({ type: 'edit', text: 'fixed', messageId: '10' })
  })

  it('normalizes a slash command', () => {
    const ev = normalizeTelegramInbound({
      update_id: 3,
      message: {
        message_id: 11,
        chat: { id: 5 },
        date: 1,
        text: '/start now',
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    })
    expect(ev).toMatchObject({ type: 'command', command: 'start', text: '/start now' })
  })

  it('normalizes a callback_query', () => {
    const ev = normalizeTelegramInbound({
      update_id: 4,
      callback_query: {
        id: 'cq1',
        from: { id: 9 },
        data: 'approve',
        message: { message_id: 10, chat: { id: 5 } },
      },
    })
    expect(ev).toMatchObject({
      type: 'callback',
      callbackId: 'approve',
      messageId: '10',
      eventId: 'cq1',
    })
  })

  it('normalizes a message_reaction', () => {
    const ev = normalizeTelegramInbound({
      update_id: 5,
      message_reaction: {
        chat: { id: 5 },
        message_id: 10,
        user: { id: 9 },
        new_reaction: [{ emoji: '🔥' }],
        date: 1,
      },
    })
    expect(ev).toMatchObject({ type: 'reaction', reaction: '🔥', messageId: '10' })
  })

  it('returns null for an empty update', () => {
    expect(normalizeTelegramInbound({ update_id: 6 })).toBeNull()
  })
})

describe('normalizeTelegramInbound — robustness', () => {
  it('returns null for null/undefined/non-object updates (no throw)', () => {
    for (const bad of [null, undefined, 'str', 42, []]) {
      expect(normalizeTelegramInbound(bad)).toBeNull()
    }
  })

  it('returns null for null nested payloads (callback_query/message_reaction/message)', () => {
    for (const u of [
      { update_id: 1, callback_query: null },
      { update_id: 1, message_reaction: null },
      { update_id: 1, message: null },
      { update_id: 1, edited_message: null },
    ]) {
      expect(() => normalizeTelegramInbound(u)).not.toThrow()
      expect(normalizeTelegramInbound(u)).toBeNull()
    }
  })
})
