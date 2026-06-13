---
title: Email (IMAP/SMTP)
---

# Email (IMAP/SMTP)

`@skelm/integration-email` is a generic email integration built on the
[integration primitives](/reference/integration-primitives). It sends mail over
SMTP and polls a mailbox over IMAP, with no provider lock-in.

## Surface

| Kind    | Id            | Purpose                                                   |
| ------- | ------------- | --------------------------------------------------------- |
| Action  | `email.send`  | Send an email over SMTP (to/cc/bcc, subject, text/html, attachments). |
| Trigger | `email.poll`  | Poll an IMAP mailbox for new messages; emits one normalized event per message. |
| Action  | `email.list`  | List/fetch messages from an IMAP mailbox.                 |

All require the `network` permission. When the permission is omitted the action
is denied — default-deny is structural.

## Action / trigger contract

### `email.send`

```ts
import { sendEmail } from '@skelm/integration-email'

const result = await sendEmail(
  {
    from: 'me@example.com',
    to: ['you@example.com'],
    cc: [{ address: 'cc@example.com', name: 'CC' }],
    subject: 'Report',
    html: '<p>Done</p>',
    attachments: [{ filename: 'r.txt', content: 'data', contentType: 'text/plain' }],
  },
  resolvedCreds,   // supplied by the gateway at dispatch
  createTransport, // injected SMTP transport factory
)
// result: { messageId, accepted: string[], rejected: string[] }
```

`shapeOutboundMessage()` normalizes the input (string recipients become address
objects) and validates that a `text` or `html` body and at least one recipient
are present, throwing `EmailMessageError` otherwise.

### `email.poll`

`pollMailbox(creds, createClient, opts)` opens an IMAP client, lists messages
newer than `opts.sinceUid`, maps each to a normalized
`EventEnvelope<EmailEventPayload>` (event type `email.message.received`, keyed by
the provider `messageId`), and suppresses duplicates with an in-process
`IdempotencyTracker`. It returns the new `events` and an advanced `highWaterUid`.
**Durable cursor persistence is the gateway's responsibility** — the function
returns the advanced uid rather than storing it.

### `email.list`

`listMessages(input, creds, createClient)` returns normalized payloads with no
trigger semantics (no idempotency, no high-water tracking).

## Injected transports (no mail dependency)

The package ships **no mail library**. Neither `nodemailer` nor `imapflow` was
present in the workspace, so rather than adding a heavy client to a
security-sensitive package, the package defines the SMTP/IMAP transport
*contract* (`SmtpTransport` / `ImapClient`) and is driven via an injected
factory — the same pattern the SDK uses for `httpRequest`'s `fetchImpl`. A host
wiring real mail libraries supplies a factory that constructs the client from
gateway-resolved credentials; tests inject a deterministic fake, so default CI
never contacts a real server.

## Credentials & security

- Credentials are **references only**. The package declares the `email-smtp` and
  `email-imap` credential schemas (host/port/user/password). The gateway
  resolves the references to ephemeral values **at dispatch** and builds the
  transport from them; values are never persisted.
- The package **never reads `process.env`** for secrets and **never holds or
  logs a password**. The resolved password is confined to the transport the
  factory creates.
- **TLS is on by default.** A missing `secure` flag is coerced to `true`; only an
  explicit `false` disables it.
- The **audit redaction policy** (`auditRedaction`) names the password and
  message body paths so the gateway's single audit writer redacts them.
  `redactMailFields()` scrubs the same fields before any value becomes a returned
  diagnostic or error message.

## Health checks

`checkSmtpHealth()` and `checkImapHealth()` open a transport, call `verify()`,
and return a `ProviderHealthCheck`. Auth failures report `unhealthy`; connection
failures report `error`. The `detail` string never contains a secret.

## Live testing

The live suite is gated on `SKELM_LIVE_EMAIL` plus the connection env vars
(`SKELM_LIVE_EMAIL_SMTP_HOST`, `SKELM_LIVE_EMAIL_SMTP_PORT`,
`SKELM_LIVE_EMAIL_IMAP_HOST`, `SKELM_LIVE_EMAIL_IMAP_PORT`,
`SKELM_LIVE_EMAIL_USER`, `SKELM_LIVE_EMAIL_PASSWORD`). When any is absent the
suite is **skipped, never failed**, so default CI stays hermetic.
