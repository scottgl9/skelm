import { describe, expect, it } from 'vitest'
import {
  createHostReplyAction,
  createHostSendAction,
  hostEventDedupeKey,
  hostIdentityKey,
  hostThreadKey,
  normalizeHostEvent,
} from '../src/host-bridge.js'

const host = { provider: 'matrix', accountId: 'acct-1', workspaceId: 'room-space' }
const thread = { kind: 'room-thread', parentId: '!room:example.org', id: '$event-thread' }

describe('host bridge normalization', () => {
  it('normalizes inbound host events with stable host, thread, and correlation keys', () => {
    const event = normalizeHostEvent({
      host,
      type: 'message.created',
      eventId: '$event-1',
      actor: { id: '@alice:example.org', type: 'user', handle: 'alice' },
      thread,
      occurredAt: '2026-01-02T03:04:05.000Z',
      receivedAt: new Date('2026-01-02T03:04:06.000Z'),
      payload: { body: 'hello' },
    })

    expect(event.occurredAt).toBe('2026-01-02T03:04:05.000Z')
    expect(event.receivedAt).toBe('2026-01-02T03:04:06.000Z')
    expect(event.dedupeKey).toBe(
      'event:matrix:account%3Aacct-1:workspace%3Aroom-space:message.created:%24event-1',
    )
    expect(event.run.correlationId).toBe(hostThreadKey(host, thread))
  })

  it('uses explicit dedupe and run correlation when adapters provide them', () => {
    const event = normalizeHostEvent({
      host,
      type: 'message.created',
      dedupeKey: 'provider-delivery-123',
      run: { pipelineId: 'chat-agent', runId: 'run-1', correlationId: 'thread-1' },
      payload: { body: 'hello' },
    })

    expect(event.dedupeKey).toBe('provider-delivery-123')
    expect(event.run).toEqual({
      pipelineId: 'chat-agent',
      runId: 'run-1',
      correlationId: 'thread-1',
    })
  })

  it('rejects missing identifiers before creating ambiguous keys', () => {
    expect(() => normalizeHostEvent({ host, type: '', payload: {} })).toThrow('type')
    expect(() => normalizeHostEvent({ host, type: 'x', eventId: '', payload: {} })).toThrow(
      'eventId',
    )
    expect(() => normalizeHostEvent({ host, type: 'x', actor: { id: '' }, payload: {} })).toThrow(
      'actor.id',
    )
    expect(() => normalizeHostEvent({ host, type: 'x', thread: { id: '' }, payload: {} })).toThrow(
      'thread.id',
    )
  })
})

describe('host bridge keys', () => {
  it('builds stable host and thread keys without provider-specific assumptions', () => {
    expect(hostIdentityKey(host)).toBe('matrix:account%3Aacct-1:workspace%3Aroom-space')
    expect(hostThreadKey(host, thread)).toBe(
      'matrix:account%3Aacct-1:workspace%3Aroom-space:kind%3Aroom-thread:parent%3A!room%3Aexample.org:thread%3A%24event-thread',
    )
  })

  it('derives fallback dedupe keys from event id or thread timestamp', () => {
    expect(
      hostEventDedupeKey({
        host,
        type: 'message.created',
        eventId: '$event-1',
        payload: {},
      }),
    ).toBe('event:matrix:account%3Aacct-1:workspace%3Aroom-space:message.created:%24event-1')

    expect(
      hostEventDedupeKey({
        host,
        type: 'message.created',
        thread,
        occurredAt: 1_767_222_400_000,
        payload: {},
      }),
    ).toContain('2025-12-31T23%3A06%3A40.000Z')
  })
})

describe('host bridge outbound actions', () => {
  it('creates send envelopes with stable idempotency keys', () => {
    const action = createHostSendAction({
      host,
      target: thread,
      body: { text: 'new message', data: { format: 'plain' } },
      run: { runId: 'run-123', correlationId: 'thread-1' },
    })

    expect(action.kind).toBe('send')
    expect(action.target).toEqual(thread)
    expect(action.replyTo).toBeUndefined()
    expect(action.idempotencyKey).toContain('send:')
    expect(action.idempotencyKey).toContain('run-123')
  })

  it('creates reply envelopes from normalized events', () => {
    const event = normalizeHostEvent({
      host,
      type: 'message.created',
      eventId: '$event-2',
      thread,
      payload: { body: 'question' },
    })

    const action = createHostReplyAction({ event, body: { text: 'answer' } })

    expect(action.kind).toBe('reply')
    expect(action.host).toEqual(host)
    expect(action.replyTo).toEqual(thread)
    expect(action.target).toBeUndefined()
    expect(action.run).toEqual(event.run)
  })

  it('requires a thread for reply envelopes', () => {
    const event = normalizeHostEvent({ host, type: 'message.created', payload: {} })
    expect(() => createHostReplyAction({ event, body: { text: 'answer' } })).toThrow('event.thread')
  })
})
