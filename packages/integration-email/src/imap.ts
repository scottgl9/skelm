/**
 * IMAP poll trigger and list/fetch action.
 *
 * The poll trigger opens an {@link ImapClient} from gateway-resolved
 * credentials via the injected factory, lists new messages since the last seen
 * uid, normalizes each into an {@link EventEnvelope} via the SDK's
 * `normalizeWebhook`, and suppresses duplicates with an
 * {@link IdempotencyTracker}. State (the high-water uid) is returned to the
 * caller — the gateway owns durable cursor persistence; this is a pure mapping.
 */

import { type EventEnvelope, IdempotencyTracker, normalizeWebhook } from '@skelm/integration-sdk'
import type {
  FetchedMessage,
  ImapClient,
  ImapClientFactory,
  ListCriteria,
  ResolvedMailCredentials,
} from './transport.js'

export const EMAIL_SOURCE = 'email'
export const EMAIL_MESSAGE_EVENT = 'email.message.received'

/** Non-secret normalized payload carried by an inbound email event. */
export interface EmailEventPayload {
  readonly uid: string
  readonly messageId: string
  readonly from: string
  readonly to: readonly string[]
  readonly cc?: readonly string[]
  readonly subject: string
  readonly date: number
  readonly text?: string
  readonly html?: string
  readonly attachmentNames?: readonly string[]
}

function payloadFrom(msg: FetchedMessage): EmailEventPayload {
  return {
    uid: msg.uid,
    messageId: msg.messageId,
    from: msg.from.address,
    to: msg.to.map((a) => a.address),
    ...(msg.cc ? { cc: msg.cc.map((a) => a.address) } : {}),
    subject: msg.subject,
    date: msg.date,
    ...(msg.text !== undefined ? { text: msg.text } : {}),
    ...(msg.html !== undefined ? { html: msg.html } : {}),
    ...(msg.attachmentNames ? { attachmentNames: msg.attachmentNames } : {}),
  }
}

/**
 * Map one fetched message into a normalized {@link EventEnvelope}. The provider
 * messageId is the stable event id, so the same message never produces two
 * distinct envelopes. Pure — no transport.
 */
export function toEmailEvent(msg: FetchedMessage): EventEnvelope<EmailEventPayload> {
  return normalizeWebhook<EmailEventPayload>({
    source: EMAIL_SOURCE,
    type: EMAIL_MESSAGE_EVENT,
    id: msg.messageId,
    payload: payloadFrom(msg),
    receivedAt: msg.date,
    metadata: { uid: msg.uid, mailbox: 'INBOX' },
  })
}

/** Numeric-aware uid comparison; non-numeric uids fall back to string order. */
function uidGreater(a: string, b: string): boolean {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na > nb
  return a > b
}

/** Options for a single {@link pollMailbox} pass. */
export interface PollOptions {
  readonly mailbox?: string
  /** High-water uid from the previous poll; only newer messages are emitted. */
  readonly sinceUid?: string
  readonly unseenOnly?: boolean
  readonly limit?: number
  /** Reused across polls by the caller to suppress duplicate ids in-process. */
  readonly idempotency?: IdempotencyTracker
}

/** Result of a poll pass: new events and the advanced high-water uid. */
export interface PollResult {
  readonly events: readonly EventEnvelope<EmailEventPayload>[]
  /** Highest uid observed this pass; undefined when the mailbox was empty. */
  readonly highWaterUid?: string
}

/**
 * Poll a mailbox once for new messages and map them to normalized events. The
 * gateway supplies resolved credentials and the client factory; this function
 * opens the client, lists, normalizes, and always closes the client. Cursor
 * persistence is the gateway's job — the advanced uid is returned, not stored.
 */
export async function pollMailbox(
  creds: ResolvedMailCredentials,
  createClient: ImapClientFactory,
  opts: PollOptions = {},
): Promise<PollResult> {
  const secureCreds: ResolvedMailCredentials = { ...creds, secure: creds.secure ?? true }
  const client: ImapClient = await createClient(secureCreds)
  try {
    const criteria: ListCriteria = {
      ...(opts.mailbox ? { mailbox: opts.mailbox } : {}),
      ...(opts.sinceUid ? { sinceUid: opts.sinceUid } : {}),
      ...(opts.unseenOnly !== undefined ? { unseenOnly: opts.unseenOnly } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    }
    const messages = await client.list(criteria)
    const tracker = opts.idempotency ?? new IdempotencyTracker()
    const events: EventEnvelope<EmailEventPayload>[] = []
    let highWater = opts.sinceUid
    for (const msg of messages) {
      if (opts.sinceUid !== undefined && !uidGreater(msg.uid, opts.sinceUid)) continue
      if (highWater === undefined || uidGreater(msg.uid, highWater)) highWater = msg.uid
      if (tracker.seen(msg.messageId)) continue
      events.push(toEmailEvent(msg))
    }
    return highWater === undefined ? { events } : { events, highWaterUid: highWater }
  } finally {
    await client.close()
  }
}

/** Input to {@link listMessages}. */
export interface ListMessagesInput {
  readonly mailbox?: string
  readonly sinceUid?: string
  readonly unseenOnly?: boolean
  readonly limit?: number
}

/**
 * List/fetch messages from a mailbox without trigger semantics (no idempotency,
 * no high-water tracking). Returns normalized payloads. Always closes the
 * client.
 */
export async function listMessages(
  input: ListMessagesInput,
  creds: ResolvedMailCredentials,
  createClient: ImapClientFactory,
): Promise<readonly EmailEventPayload[]> {
  const secureCreds: ResolvedMailCredentials = { ...creds, secure: creds.secure ?? true }
  const client = await createClient(secureCreds)
  try {
    const criteria: ListCriteria = {
      ...(input.mailbox ? { mailbox: input.mailbox } : {}),
      ...(input.sinceUid ? { sinceUid: input.sinceUid } : {}),
      ...(input.unseenOnly !== undefined ? { unseenOnly: input.unseenOnly } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }
    const messages = await client.list(criteria)
    return messages.map(payloadFrom)
  } finally {
    await client.close()
  }
}
