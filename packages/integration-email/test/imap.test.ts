import { IdempotencyTracker } from '@skelm/integration-sdk'
import { describe, expect, it } from 'vitest'
import {
  EMAIL_MESSAGE_EVENT,
  EMAIL_SOURCE,
  listMessages,
  pollMailbox,
  toEmailEvent,
} from '../src/imap.js'
import type { FetchedMessage } from '../src/transport.js'
import { RESOLVED_CREDS, SAMPLE_MESSAGE, makeImapFake } from './fakes.js'

function msg(uid: string, messageId = `<${uid}@example.test>`): FetchedMessage {
  return {
    uid,
    messageId,
    from: { address: 'sender@example.test' },
    to: [{ address: 'inbox@example.test' }],
    subject: `subject ${uid}`,
    date: 1_700_000_000_000 + Number(uid),
    text: 'body',
  }
}

describe('toEmailEvent', () => {
  it('maps a fetched message to a normalized envelope keyed by messageId', () => {
    const event = toEmailEvent(SAMPLE_MESSAGE)
    expect(event.source).toBe(EMAIL_SOURCE)
    expect(event.type).toBe(EMAIL_MESSAGE_EVENT)
    expect(event.id).toBe('<msg-42@example.test>')
    expect(event.payload.from).toBe('sender@example.test')
    expect(event.payload.to).toEqual(['inbox@example.test'])
    expect(event.metadata?.uid).toBe('42')
  })

  it('flattens addresses to strings in the payload', () => {
    const event = toEmailEvent(msg('7'))
    expect(event.payload.from).toBe('sender@example.test')
    expect(typeof event.payload.subject).toBe('string')
  })
})

describe('pollMailbox', () => {
  it('emits an event per new message and advances the high-water uid', async () => {
    const { factory } = makeImapFake([msg('1'), msg('2'), msg('3')])
    const result = await pollMailbox(RESOLVED_CREDS, factory)
    expect(result.events).toHaveLength(3)
    expect(result.highWaterUid).toBe('3')
  })

  it('only emits messages newer than sinceUid', async () => {
    const { factory } = makeImapFake([msg('1'), msg('2'), msg('3')])
    const result = await pollMailbox(RESOLVED_CREDS, factory, { sinceUid: '2' })
    expect(result.events.map((e) => e.metadata?.uid)).toEqual(['3'])
    expect(result.highWaterUid).toBe('3')
  })

  it('suppresses duplicate messageIds across polls via a shared tracker', async () => {
    const tracker = new IdempotencyTracker()
    const { factory } = makeImapFake([msg('1')])
    const first = await pollMailbox(RESOLVED_CREDS, factory, { idempotency: tracker })
    const second = await pollMailbox(RESOLVED_CREDS, factory, { idempotency: tracker })
    expect(first.events).toHaveLength(1)
    expect(second.events).toHaveLength(0)
  })

  it('advances high-water uid past deduped messages', async () => {
    const tracker = new IdempotencyTracker()
    const firstFactory = makeImapFake([msg('1', '<dup@example.test>')]).factory
    await pollMailbox(RESOLVED_CREDS, firstFactory, { idempotency: tracker })

    const { factory } = makeImapFake([msg('2', '<dup@example.test>')])
    const result = await pollMailbox(RESOLVED_CREDS, factory, {
      sinceUid: '1',
      idempotency: tracker,
    })

    expect(result.events).toHaveLength(0)
    expect(result.highWaterUid).toBe('2')
  })

  it('passes mailbox and unseenOnly criteria through to the client', async () => {
    const { factory, transports } = makeImapFake([])
    await pollMailbox(RESOLVED_CREDS, factory, { mailbox: 'Archive', unseenOnly: true })
    expect(transports[0]?.lastCriteria).toMatchObject({ mailbox: 'Archive', unseenOnly: true })
  })

  it('returns no high-water uid for an empty mailbox', async () => {
    const { factory } = makeImapFake([])
    const result = await pollMailbox(RESOLVED_CREDS, factory)
    expect(result.events).toHaveLength(0)
    expect(result.highWaterUid).toBeUndefined()
  })

  it('defaults TLS on and closes the client', async () => {
    const { factory, transports } = makeImapFake([])
    await pollMailbox(RESOLVED_CREDS, factory)
    expect(transports[0]?.receivedCreds?.secure).toBe(true)
    expect(transports[0]?.closed()).toBe(true)
  })
})

describe('listMessages', () => {
  it('returns normalized payloads without trigger semantics', async () => {
    const { factory } = makeImapFake([msg('1'), msg('2')])
    const out = await listMessages({ mailbox: 'INBOX', limit: 10 }, RESOLVED_CREDS, factory)
    expect(out).toHaveLength(2)
    expect(out[0]?.uid).toBe('1')
  })
})
