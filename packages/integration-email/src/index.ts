/**
 * @skelm/integration-email
 *
 * Generic IMAP/SMTP email integration built on @skelm/integration-sdk
 * primitives. Provides an SMTP send action, an IMAP poll trigger, and an IMAP
 * list/fetch action.
 *
 * SECURITY: credentials are references only; the gateway resolves them at
 * dispatch and constructs the transport via the injected factory. This package
 * never reads `process.env`, never stores a password, and never logs one. TLS
 * is on by default. See {@link transport} for the dependency-free,
 * injected-transport design.
 */

// Transport contracts (injected — this package ships no mail library)
export type {
  ResolvedMailCredentials,
  MailAddress,
  MailAttachment,
  OutboundMessage,
  SendResult,
  SmtpTransport,
  FetchedMessage,
  ListCriteria,
  ImapClient,
  SmtpTransportFactory,
  ImapClientFactory,
} from './transport.js'

// Errors
export {
  EmailIntegrationError,
  EmailAuthError,
  EmailTransientError,
  EmailMessageError,
} from './errors.js'

// Error classification
export { classifyError, isRetryableMailError } from './classify.js'
export type { ErrorClass } from './classify.js'

// Credentials (references only — never values)
export {
  MAIL_CREDENTIAL_FIELDS,
  SMTP_CREDENTIAL_SCHEMA,
  IMAP_CREDENTIAL_SCHEMA,
} from './credentials.js'
export type { MailConnectionRefs } from './credentials.js'

// SMTP send action
export { sendEmail, shapeOutboundMessage, sendEmailInputSchema } from './smtp.js'
export type { SendEmailInput } from './smtp.js'

// IMAP poll trigger + list/fetch action
export {
  EMAIL_SOURCE,
  EMAIL_MESSAGE_EVENT,
  toEmailEvent,
  pollMailbox,
  listMessages,
} from './imap.js'
export type {
  EmailEventPayload,
  PollOptions,
  PollResult,
  ListMessagesInput,
} from './imap.js'

// Health checks
export { checkSmtpHealth, checkImapHealth } from './health.js'

// Audit redaction
export { EMAIL_AUDIT_REDACTION, redactMailFields } from './redaction.js'

// Integration-package manifest
export {
  emailIntegrationManifest,
  SEND_EMAIL_ACTION,
  LIST_MESSAGES_ACTION,
  POLL_TRIGGER,
} from './manifest.js'
