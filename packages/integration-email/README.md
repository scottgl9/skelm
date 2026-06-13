# @skelm/integration-email

Generic **IMAP/SMTP** email integration for skelm, built on the
`@skelm/integration-sdk` primitives.

It provides:

- an **SMTP send action** (`email.send`) — to/cc/bcc, subject, text/html,
  attachments, custom headers;
- an **IMAP poll trigger** (`email.poll`) — polls a mailbox for new messages and
  emits one normalized SDK event per message;
- an **IMAP list/fetch action** (`email.list`) — list messages from a mailbox
  without trigger semantics.

## Design: injected transports, no mail dependency

This package ships **no mail library**. Neither `nodemailer` nor `imapflow` was
present in the workspace, and pulling a heavy mail client into a
security-sensitive package would widen the supply-chain and maintenance surface
for code whose only privileged job is to hand resolved credentials to a
transport.

Instead the package defines the SMTP/IMAP transport **contract**
(`SmtpTransport` / `ImapClient`) and is driven via an **injected transport** —
the same pattern the SDK uses for `httpRequest`'s `fetchImpl`. A host wiring real
mail libraries supplies a factory that constructs the client from
gateway-resolved credentials:

```ts
import { sendEmail, type SmtpTransportFactory } from '@skelm/integration-email'

// The gateway resolves credential refs to `creds` at dispatch and supplies a
// factory that builds a real (e.g. nodemailer-backed) transport from them.
const createTransport: SmtpTransportFactory = async (creds) => {
  /* construct your SMTP client from creds; never store/log creds.password */
}

const result = await sendEmail(
  { from: 'me@example.com', to: 'you@example.com', subject: 'Hi', text: 'Hello' },
  creds,
  createTransport,
)
```

Tests inject a deterministic in-memory fake, so default CI never contacts a real
server.

## Credentials & security

- Credentials are **references only** (`CredentialReference`). The package
  declares `email-smtp` and `email-imap` credential schemas (host/port/user/
  password). The gateway resolves them to ephemeral values at **dispatch** and
  constructs the transport from those values — they are never stored.
- The package **never reads `process.env`** for secrets and **never holds or
  logs a password**. The resolved password lives only inside the transport the
  factory creates.
- **TLS is on by default.** When `secure` is omitted on the resolved
  credentials it is coerced to `true`; only an explicit `false` disables it.
- An **audit redaction policy** names the password and message body paths
  (`credentials.password`, `message.text`, `message.html`, …) so the gateway's
  single audit writer redacts them. `redactMailFields()` scrubs the same fields
  before any value is returned as a diagnostic or embedded in an error.

## Live testing

The live suite is gated on `SKELM_LIVE_EMAIL` plus connection env vars
(`SKELM_LIVE_EMAIL_SMTP_HOST`, `SKELM_LIVE_EMAIL_IMAP_HOST`, …). When they are
absent the suite is **skipped**, never failed, so default CI is hermetic.

See [docs/integrations/email](https://skelm.dev/integrations/email) for the full
action/trigger contract.
