/**
 * Transport contracts for the email integration.
 *
 * DEPENDENCY CHOICE: this package ships NO mail library (no `nodemailer`, no
 * `imapflow`). Neither is present in the workspace, and pulling a heavy mail
 * client into a security-sensitive package would widen the maintenance and
 * supply-chain surface for code whose only privileged job is to hand resolved
 * credentials to a transport. Instead the package defines the SMTP/IMAP
 * transport CONTRACT (the interfaces below) and is driven via an INJECTED
 * transport — exactly the pattern the SDK already uses for `httpRequest`'s
 * `fetchImpl`. A host wiring real mail libs supplies a `SmtpTransport` /
 * `ImapClient` whose factory constructs the client from gateway-resolved
 * credentials; tests supply a deterministic fake. No real server is contacted
 * in default CI.
 *
 * SECURITY INVARIANT: resolved credentials live only inside the transport the
 * gateway constructs at dispatch. This package never reads `process.env`, never
 * stores a password, and never logs one. The {@link ResolvedMailCredentials}
 * type is the only place a password value appears, and it is passed straight to
 * a transport factory — never retained, never serialized.
 */

/**
 * Ephemeral, gateway-resolved connection credentials. The gateway resolves the
 * package's {@link CredentialReference}s to this shape at dispatch and hands it
 * to a transport factory. It is never persisted, logged, or returned from an
 * action.
 */
export interface ResolvedMailCredentials {
  readonly host: string
  readonly port: number
  readonly user: string
  /** Resolved secret. Confined to the transport factory; never stored or logged. */
  readonly password: string
  /**
   * Whether to negotiate TLS. Defaults to true (secure-by-default) wherever a
   * value is constructed; only an explicit `false` disables it.
   */
  readonly secure?: boolean
}

/** A single recipient/sender address with an optional display name. */
export interface MailAddress {
  readonly address: string
  readonly name?: string
}

/** An outbound attachment. Content is caller-supplied bytes/string, never a secret. */
export interface MailAttachment {
  readonly filename: string
  readonly content: string | Uint8Array
  readonly contentType?: string
}

/** The normalized message a {@link SmtpTransport} is asked to send. */
export interface OutboundMessage {
  readonly from: MailAddress
  readonly to: readonly MailAddress[]
  readonly cc?: readonly MailAddress[]
  readonly bcc?: readonly MailAddress[]
  readonly subject: string
  readonly text?: string
  readonly html?: string
  readonly attachments?: readonly MailAttachment[]
  /** Additional non-secret headers. */
  readonly headers?: Readonly<Record<string, string>>
}

/** Result of a send: the provider message id and accepted/rejected recipients. */
export interface SendResult {
  readonly messageId: string
  readonly accepted: readonly string[]
  readonly rejected: readonly string[]
}

/**
 * SMTP transport contract. A host wiring `nodemailer` (or any client)
 * implements this; the package never constructs one itself. Implementations
 * MUST hold the resolved password only for the lifetime of the connection and
 * MUST NOT log it.
 */
export interface SmtpTransport {
  send(message: OutboundMessage): Promise<SendResult>
  /** Verify the SMTP connection/auth without sending. */
  verify(): Promise<void>
  close(): Promise<void>
}

/** A normalized fetched message as returned by an {@link ImapClient}. */
export interface FetchedMessage {
  /** Stable per-mailbox message uid. */
  readonly uid: string
  readonly messageId: string
  readonly from: MailAddress
  readonly to: readonly MailAddress[]
  readonly cc?: readonly MailAddress[]
  readonly subject: string
  /** Epoch milliseconds the provider reports the message arrived. */
  readonly date: number
  readonly text?: string
  readonly html?: string
  readonly flags?: readonly string[]
  readonly attachmentNames?: readonly string[]
}

/** Criteria for listing/polling a mailbox. */
export interface ListCriteria {
  readonly mailbox?: string
  /** Only return messages with a uid strictly greater than this. */
  readonly sinceUid?: string
  /** Only return unseen messages when true. */
  readonly unseenOnly?: boolean
  /** Hard cap on returned messages per call. */
  readonly limit?: number
}

/**
 * IMAP client contract. A host wiring `imapflow` (or any client) implements
 * this; the package never constructs one itself.
 */
export interface ImapClient {
  list(criteria: ListCriteria): Promise<readonly FetchedMessage[]>
  /** Fetch a single message by uid from a mailbox. */
  fetch(uid: string, mailbox?: string): Promise<FetchedMessage | undefined>
  /** Verify the IMAP connection/auth (e.g. open INBOX). */
  verify(): Promise<void>
  close(): Promise<void>
}

/**
 * Factory the gateway supplies to construct a transport from resolved
 * credentials at dispatch. The resolved password is confined to the factory's
 * closure and the transport it returns.
 */
export type SmtpTransportFactory = (creds: ResolvedMailCredentials) => Promise<SmtpTransport>
export type ImapClientFactory = (creds: ResolvedMailCredentials) => Promise<ImapClient>
