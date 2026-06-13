/**
 * Deterministic in-memory fakes for the injected SMTP/IMAP transports. No real
 * server is contacted. Each fake records every value it ever observes so tests
 * can assert that a resolved password never reaches it as a logged/observable
 * field — and that the transport receives credentials only via its factory.
 */

import type {
  FetchedMessage,
  ImapClient,
  ListCriteria,
  OutboundMessage,
  ResolvedMailCredentials,
  SendResult,
  SmtpTransport,
} from '../src/transport.js'

export interface SmtpFake extends SmtpTransport {
  readonly sent: OutboundMessage[]
  readonly receivedCreds: ResolvedMailCredentials | undefined
  readonly closed: () => boolean
}

export function makeSmtpFake(opts: { failVerify?: unknown; failSend?: unknown } = {}): {
  factory: (c: ResolvedMailCredentials) => Promise<SmtpFake>
  transports: SmtpFake[]
} {
  const transports: SmtpFake[] = []
  const factory = async (creds: ResolvedMailCredentials): Promise<SmtpFake> => {
    const sent: OutboundMessage[] = []
    let isClosed = false
    const t: SmtpFake = {
      sent,
      receivedCreds: creds,
      closed: () => isClosed,
      async send(message: OutboundMessage): Promise<SendResult> {
        if (opts.failSend) throw opts.failSend
        sent.push(message)
        return {
          messageId: '<sent-1@example.test>',
          accepted: message.to.map((a) => a.address),
          rejected: [],
        }
      },
      async verify(): Promise<void> {
        if (opts.failVerify) throw opts.failVerify
      },
      async close(): Promise<void> {
        isClosed = true
      },
    }
    transports.push(t)
    return t
  }
  return { factory, transports }
}

export interface ImapFake extends ImapClient {
  readonly receivedCreds: ResolvedMailCredentials | undefined
  readonly lastCriteria: ListCriteria | undefined
  readonly closed: () => boolean
}

export function makeImapFake(
  messages: readonly FetchedMessage[],
  opts: { failVerify?: unknown } = {},
): {
  factory: (c: ResolvedMailCredentials) => Promise<ImapFake>
  transports: ImapFake[]
} {
  const transports: ImapFake[] = []
  const factory = async (creds: ResolvedMailCredentials): Promise<ImapFake> => {
    let isClosed = false
    let lastCriteria: ListCriteria | undefined
    const t: ImapFake = {
      receivedCreds: creds,
      get lastCriteria() {
        return lastCriteria
      },
      closed: () => isClosed,
      async list(criteria: ListCriteria): Promise<readonly FetchedMessage[]> {
        lastCriteria = criteria
        return messages
      },
      async fetch(uid: string): Promise<FetchedMessage | undefined> {
        return messages.find((m) => m.uid === uid)
      },
      async verify(): Promise<void> {
        if (opts.failVerify) throw opts.failVerify
      },
      async close(): Promise<void> {
        isClosed = true
      },
    }
    transports.push(t)
    return t
  }
  return { factory, transports }
}

export const SAMPLE_MESSAGE: FetchedMessage = {
  uid: '42',
  messageId: '<msg-42@example.test>',
  from: { address: 'sender@example.test', name: 'Sender' },
  to: [{ address: 'inbox@example.test' }],
  subject: 'Hello',
  date: 1_700_000_000_000,
  text: 'secret body text',
  flags: ['\\Seen'],
}

export const RESOLVED_CREDS: ResolvedMailCredentials = {
  host: 'mail.example.test',
  port: 993,
  user: 'inbox@example.test',
  password: 'super-secret-password',
}
