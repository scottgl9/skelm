/**
 * Integration-package manifest for @skelm/integration-email.
 *
 * Declares the SMTP send action, IMAP poll trigger, IMAP list/fetch action, the
 * SMTP/IMAP credential schemas (references only), required permissions
 * (network egress to the mail hosts), a deterministic mock fixture, an
 * `SKELM_LIVE_EMAIL`-gated live-test descriptor, and the audit redaction policy
 * covering the password and message bodies.
 */

import type {
  ActionDefinition,
  IntegrationPackageManifest,
  LiveTestDescriptor,
  MockProviderFixture,
  TriggerDefinition,
} from '@skelm/integration-sdk'
import { IMAP_CREDENTIAL_SCHEMA, SMTP_CREDENTIAL_SCHEMA } from './credentials.js'
import { EMAIL_MESSAGE_EVENT } from './imap.js'
import { EMAIL_AUDIT_REDACTION } from './redaction.js'

export const SEND_EMAIL_ACTION: ActionDefinition = {
  id: 'email.send',
  description: 'Send an email over SMTP (to/cc/bcc, subject, text/html, attachments).',
  requiredPermissions: ['network'],
}

export const LIST_MESSAGES_ACTION: ActionDefinition = {
  id: 'email.list',
  description: 'List/fetch messages from an IMAP mailbox.',
  requiredPermissions: ['network'],
}

export const POLL_TRIGGER: TriggerDefinition = {
  id: 'email.poll',
  kind: 'poll',
  description: 'Poll an IMAP mailbox for new messages and emit a normalized event per message.',
  events: [EMAIL_MESSAGE_EVENT],
}

const MOCK_FIXTURE: MockProviderFixture = {
  provider: 'email',
  description: 'Canned IMAP message and SMTP send result for deterministic CI.',
  payloads: {
    imapMessage: {
      uid: '42',
      messageId: '<msg-42@example.test>',
      from: { address: 'sender@example.test', name: 'Sender' },
      to: [{ address: 'inbox@example.test' }],
      subject: 'Hello',
      date: 1_700_000_000_000,
      text: 'body text',
      flags: ['\\Seen'],
    },
    smtpSendResult: {
      messageId: '<sent-1@example.test>',
      accepted: ['inbox@example.test'],
      rejected: [],
    },
  },
}

const LIVE_TEST: LiveTestDescriptor = {
  provider: 'email',
  name: 'IMAP/SMTP round-trip',
  description:
    'Connects to a real mail server using SKELM_LIVE_EMAIL credential env vars; skipped unless all are set.',
  requiredEnv: [
    'SKELM_LIVE_EMAIL',
    'SKELM_LIVE_EMAIL_SMTP_HOST',
    'SKELM_LIVE_EMAIL_SMTP_PORT',
    'SKELM_LIVE_EMAIL_IMAP_HOST',
    'SKELM_LIVE_EMAIL_IMAP_PORT',
    'SKELM_LIVE_EMAIL_USER',
    'SKELM_LIVE_EMAIL_PASSWORD',
  ],
}

export const emailIntegrationManifest: IntegrationPackageManifest = {
  name: '@skelm/integration-email',
  version: '0.4.8',
  description: 'Generic IMAP/SMTP email integration.',
  actions: [SEND_EMAIL_ACTION, LIST_MESSAGES_ACTION],
  triggers: [POLL_TRIGGER],
  credentials: [SMTP_CREDENTIAL_SCHEMA, IMAP_CREDENTIAL_SCHEMA],
  requiredPermissions: ['network'],
  supportedEvents: [EMAIL_MESSAGE_EVENT],
  dashboard: {
    title: 'Email (IMAP/SMTP)',
    fields: {
      smtp: { host: 'string', port: 'number', user: 'string', password: 'secret' },
      imap: { host: 'string', port: 'number', user: 'string', password: 'secret' },
      tls: { default: true },
    },
  },
  mockFixtures: [MOCK_FIXTURE],
  liveTests: [LIVE_TEST],
  auditRedaction: EMAIL_AUDIT_REDACTION,
}
