/**
 * Credential schema for the email integration — references only, never values.
 *
 * SMTP and IMAP each need host/port/user/password. These are declared by name
 * and shape via {@link CredentialSchema}; the operator binds them to gateway
 * secrets through {@link CredentialReference}s. The gateway resolves the refs to
 * a {@link ResolvedMailCredentials} at dispatch and constructs the transport.
 * This package never reads `process.env` and never holds a resolved password.
 */

import type { CredentialReference, CredentialSchema } from '@skelm/integration-sdk'

/** Field names used across SMTP and IMAP credential sets. */
export const MAIL_CREDENTIAL_FIELDS = {
  host: 'host',
  port: 'port',
  user: 'user',
  password: 'password',
} as const

/** Credential set an SMTP send connection requires. */
export const SMTP_CREDENTIAL_SCHEMA: CredentialSchema = {
  id: 'email-smtp',
  description: 'SMTP submission credentials. TLS is on by default.',
  fields: [
    { name: 'host', kind: 'string', description: 'SMTP server hostname.' },
    { name: 'port', kind: 'number', description: 'SMTP submission port (e.g. 465 or 587).' },
    { name: 'user', kind: 'string', description: 'SMTP auth username.' },
    { name: 'password', kind: 'token', description: 'SMTP auth password/app-password.' },
  ],
}

/** Credential set an IMAP poll/fetch connection requires. */
export const IMAP_CREDENTIAL_SCHEMA: CredentialSchema = {
  id: 'email-imap',
  description: 'IMAP mailbox credentials. TLS is on by default.',
  fields: [
    { name: 'host', kind: 'string', description: 'IMAP server hostname.' },
    { name: 'port', kind: 'number', description: 'IMAP port (e.g. 993).' },
    { name: 'user', kind: 'string', description: 'IMAP auth username.' },
    { name: 'password', kind: 'token', description: 'IMAP auth password/app-password.' },
  ],
}

/**
 * The set of credential references that back a mail connection. The gateway
 * resolves these to ephemeral values at dispatch. Carries no values.
 */
export interface MailConnectionRefs {
  readonly host: CredentialReference
  readonly port: CredentialReference
  readonly user: CredentialReference
  readonly password: CredentialReference
}
