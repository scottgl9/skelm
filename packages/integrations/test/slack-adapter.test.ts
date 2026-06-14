import type { Connection } from '@skelm/integration-sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  SlackConversationAdapter,
  type SlackTransport,
  normalizeSlackInbound,
} from '../src/slack-adapter.js'
import { verifySlackSignature } from '../src/slack.js'

function connection(): Connection {
  return {
    id: 'conn-slack',
    integrationId: 'slack',
    credentialSchemaId: 'slack',
    credentials: [{ kind: 'credential-ref', secretName: 'SLACK_BOT_TOKEN' }],
  }
}

function okTransport(
  result: Record<string, unknown> = { ok: true, channel: 'C1', ts: '1700000000.0001' },
): { transport: SlackTransport; calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = []
  const transport: SlackTransport = async (method, body) => {
    calls.push([method, body as Record<string, unknown>])
    return result as never
  }
  return { transport, calls }
}

describe('SlackConversationAdapter', () => {
  it('advertises only capability ops it implements', () => {
    const adapter = new SlackConversationAdapter(okTransport().transport)
    const c = adapter.capabilities
    const fn = (op: string) => typeof (adapter as unknown as Record<string, unknown>)[op]
    expect(c.provider).toBe('slack')
    // Each advertised capability must be backed by its concrete op(s).
    if (c.editMessage) expect(fn('editMessage')).toBe('function')
    if (c.deleteMessage) expect(fn('deleteMessage')).toBe('function')
    if (c.replyInThread) expect(fn('replyInThread')).toBe('function')
    if (c.reactions) {
      expect(fn('addReaction')).toBe('function')
      expect(fn('removeReaction')).toBe('function')
    }
    // Buttons are a send-time escape hatch (Block Kit via providerOptions), not
    // a dedicated op — assert the escape hatch is declared instead.
    if (c.buttons) expect(c.escapeHatches).toContain('blockKit')
    expect(c.mediaSources).toEqual(['url'])
    // Advertised media must have a sender.
    for (const m of c.media) {
      const op = m === 'image' ? 'sendImage' : 'sendFile'
      expect(fn(op)).toBe('function')
    }
  })

  it('sendMessage shapes a chat.postMessage body and returns the ts as messageId', async () => {
    const { transport, calls } = okTransport()
    const adapter = new SlackConversationAdapter(transport)
    const ref = await adapter.sendMessage({
      target: { conversationId: 'C1', threadId: '1699.1' },
      text: 'hi',
    })
    expect(calls[0][0]).toBe('chat.postMessage')
    expect(calls[0][1]).toEqual({ channel: 'C1', text: 'hi', thread_ts: '1699.1' })
    expect(ref.messageId).toBe('1700000000.0001')
    expect(ref.target.conversationId).toBe('C1')
  })

  it('editMessage maps to chat.update', async () => {
    const { transport, calls } = okTransport()
    const adapter = new SlackConversationAdapter(transport)
    await adapter.editMessage(
      { messageId: '1700000000.0001', target: { conversationId: 'C1' } },
      { target: { conversationId: 'C1' }, text: 'edited' },
    )
    expect(calls[0][0]).toBe('chat.update')
    expect(calls[0][1]).toEqual({ channel: 'C1', ts: '1700000000.0001', text: 'edited' })
  })

  it('addReaction maps to reactions.add', async () => {
    const { transport, calls } = okTransport({ ok: true })
    const adapter = new SlackConversationAdapter(transport)
    await adapter.addReaction(
      { messageId: '1700000000.0001', target: { conversationId: 'C1' } },
      'thumbsup',
    )
    expect(calls[0][0]).toBe('reactions.add')
    expect(calls[0][1]).toEqual({ channel: 'C1', timestamp: '1700000000.0001', name: 'thumbsup' })
  })

  it('button payloads ride providerOptions (Block Kit escape hatch)', async () => {
    const { transport, calls } = okTransport()
    const adapter = new SlackConversationAdapter(transport)
    const blocks = [{ type: 'actions', elements: [{ type: 'button', text: 'Go' }] }]
    await adapter.sendMessage({
      target: { conversationId: 'C1' },
      text: 'pick',
      providerOptions: { blocks },
    })
    expect(calls[0][1]).toMatchObject({ channel: 'C1', text: 'pick', blocks })
  })

  it('throws on a non-ok transport result', async () => {
    const { transport } = okTransport({ ok: false, error: 'channel_not_found' })
    const adapter = new SlackConversationAdapter(transport)
    await expect(
      adapter.sendMessage({ target: { conversationId: 'C1' }, text: 'x' }),
    ).rejects.toThrow(/channel_not_found/)
  })

  it('rejects inline-only media sends', async () => {
    const adapter = new SlackConversationAdapter(okTransport().transport)
    await expect(
      adapter.sendFile(
        { conversationId: 'C1' },
        { kind: 'file', contentType: 'text/plain', data: 'aGVsbG8=' },
      ),
    ).rejects.toThrow(/MediaAttachment\.url/)
  })

  it('connect rejects a connection carrying a secret value', async () => {
    const adapter = new SlackConversationAdapter(okTransport().transport)
    const tainted = {
      ...connection(),
      token: 'xoxb-leaked',
    } as unknown as Connection
    await expect(adapter.connect(tainted)).rejects.toThrow(/must not carry a secret value/)
  })

  it('connect accepts a reference-only connection', async () => {
    const adapter = new SlackConversationAdapter(okTransport().transport)
    await expect(adapter.connect(connection())).resolves.toBeUndefined()
  })
})

describe('normalizeSlackInbound', () => {
  it('normalizes a message event', () => {
    const ev = normalizeSlackInbound({
      type: 'event_callback',
      event_id: 'Ev1',
      event: { type: 'message', channel: 'C1', user: 'U1', text: 'hello', ts: '1700000000.0001' },
    })
    expect(ev).toMatchObject({
      provider: 'slack',
      type: 'message',
      text: 'hello',
      messageId: '1700000000.0001',
      target: { conversationId: 'C1', userId: 'U1' },
    })
  })

  it('normalizes an app_mention to a message event', () => {
    const ev = normalizeSlackInbound({
      type: 'event_callback',
      event_id: 'Ev2',
      event: { type: 'app_mention', channel: 'C1', user: 'U1', text: '<@B> hi', ts: '170.1' },
    })
    expect(ev?.type).toBe('message')
    expect(ev?.text).toBe('<@B> hi')
  })

  it('normalizes a message_changed edit', () => {
    const ev = normalizeSlackInbound({
      type: 'event_callback',
      event_id: 'Ev3',
      event: {
        type: 'message',
        subtype: 'message_changed',
        channel: 'C1',
        message: { ts: '170.1', user: 'U1', text: 'edited' },
      },
    })
    expect(ev).toMatchObject({ type: 'edit', text: 'edited', messageId: '170.1' })
  })

  it('normalizes a reaction_added event', () => {
    const ev = normalizeSlackInbound({
      type: 'event_callback',
      event_id: 'Ev4',
      event: {
        type: 'reaction_added',
        user: 'U1',
        reaction: 'eyes',
        item: { channel: 'C1', ts: '170.1' },
      },
    })
    expect(ev).toMatchObject({ type: 'reaction', reaction: 'eyes', messageId: '170.1' })
  })

  it('normalizes a slash command', () => {
    const ev = normalizeSlackInbound({
      command: '/deploy',
      text: 'prod',
      channel_id: 'C1',
      user_id: 'U1',
      trigger_id: 'T1',
    })
    expect(ev).toMatchObject({ type: 'command', command: 'deploy', text: 'prod' })
  })

  it('normalizes a block_actions button callback', () => {
    const ev = normalizeSlackInbound({
      type: 'block_actions',
      trigger_id: 'T1',
      channel: { id: 'C1' },
      user: { id: 'U1' },
      actions: [{ action_id: 'approve', value: 'yes' }],
    })
    expect(ev).toMatchObject({ type: 'callback', callbackId: 'approve' })
  })

  it('returns null for url_verification', () => {
    expect(normalizeSlackInbound({ type: 'url_verification', challenge: 'x' })).toBeNull()
  })
})

describe('verifySlackSignature continuity', () => {
  it('still rejects a tampered body', () => {
    const { createHmac } = require('node:crypto') as typeof import('node:crypto')
    const secret = 's'
    const body = '{"a":1}'
    const ts = '1700000000'
    const sig = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`
    expect(verifySlackSignature(body, sig, ts, secret)).toBe(true)
    expect(verifySlackSignature(`${body} `, sig, ts, secret)).toBe(false)
  })

  it('the adapter does not log secrets', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const adapter = new SlackConversationAdapter(okTransport().transport)
    await adapter.connect(connection())
    await adapter.sendMessage({ target: { conversationId: 'C1' }, text: 'hi' })
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/xoxb-/)
    }
    spy.mockRestore()
  })
})

describe('normalizeSlackInbound — robustness', () => {
  it('returns null for null/undefined/non-object payloads (no throw)', () => {
    for (const bad of [null, undefined, 'str', 42, []]) {
      expect(normalizeSlackInbound(bad)).toBeNull()
    }
  })

  it('returns null for a null nested event payload (no throw)', () => {
    expect(() => normalizeSlackInbound({ type: 'event_callback', event: null })).not.toThrow()
    expect(normalizeSlackInbound({ type: 'event_callback', event: null })).toBeNull()
    expect(normalizeSlackInbound({ type: 'event_callback', event: 'oops' })).toBeNull()
  })

  it('maps a message_deleted event to a delete (not a bogus empty message)', () => {
    const ev = normalizeSlackInbound({
      type: 'event_callback',
      event: { type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: '170.5' },
    })
    expect(ev).toMatchObject({ provider: 'slack', type: 'delete', messageId: '170.5' })
  })
})
