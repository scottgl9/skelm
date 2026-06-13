# @skelm/integration-webhook

A generic **inbound webhook trigger** for skelm, built on the
[`@skelm/integration-sdk`](../integration-sdk) primitives.

It provides the typed pieces the gateway composes with its inbound webhook HTTP
surface:

- a typed `TriggerDefinition` + `WebhookEndpointDescriptor`,
- a `WebhookVerification` strategy — **HMAC** keyed by a `CredentialReference`,
  or an explicit, clearly-marked **insecure no-verification** mode,
- a normalizer that maps the raw request into the SDK `EventEnvelope` with
  configurable header/body field mapping,
- an `IntegrationPackageManifest` builder (trigger, endpoint, credential refs,
  dashboard metadata, mock fixtures, audit redaction).

This package does **not** run an HTTP server. The gateway owns the inbound
webhook HTTP surface and secret resolution; this package supplies the
descriptor, verification, and normalization.

---

## Security model

- **Signing secret by reference only.** HMAC verification names the signing
  secret with a `CredentialReference` (`{ kind: 'credential-ref', secretName }`).
  This package never reads `process.env`, never stores the value, and never
  logs or throws it. The gateway resolves the reference to an ephemeral value
  at dispatch and passes it to `verifyWebhookRequest`.
- **Default-deny verification.** The HMAC strategy **rejects** when the
  signature header is absent/empty (`missing-signature`) and when the digest
  does not match (`signature-mismatch`, constant-time). With no resolved
  secret, verification fails closed rather than throwing.
- **Explicit insecure opt-in.** Skipping verification requires the
  `no-verification` strategy with `acknowledgeInsecure: true` — it can never be
  selected by omission.
- **Audit redaction.** The manifest's redaction policy always names the
  signature header so its value cannot reach audit rows or logs.

---

## Usage

```ts
import {
  defineWebhookTrigger,
  buildWebhookManifest,
  verifyWebhookRequest,
  GENERIC_WEBHOOK_FIXTURE,
} from '@skelm/integration-webhook'

const trigger = defineWebhookTrigger({
  id: 'generic-webhook',
  source: 'webhook',
  path: '/webhooks/generic',
  verification: {
    strategy: 'hmac',
    signatureHeader: 'x-webhook-signature',
    secretRef: { kind: 'credential-ref', secretName: 'WEBHOOK_SIGNING_SECRET' },
    prefix: 'sha256=',
  },
  defaultEventType: 'webhook',
  events: ['event.created', 'event.updated'],
  normalization: {
    type: { bodyPath: 'event.type' },
    id: { bodyPath: 'event.id' },
    metadataHeaders: { deliveryId: 'x-delivery-id' },
  },
})

export const manifest = buildWebhookManifest({
  trigger,
  mockFixtures: [GENERIC_WEBHOOK_FIXTURE],
  dashboard: { title: 'Generic Webhook' },
})
```

The gateway, after resolving the signing secret, verifies and normalizes:

```ts
const verdict = verifyWebhookRequest({
  verification: trigger.config.verification,
  rawBody, // exact bytes as received
  header: (name) => request.headers.get(name),
  resolvedSecret, // resolved by the gateway from the CredentialReference
})
if (!verdict.ok) {
  // 401 — verdict.reason is 'missing-signature' | 'signature-mismatch'
}
const envelope = trigger.normalize({ header: (n) => request.headers.get(n), body })
```

### Explicit insecure mode

```ts
verification: { strategy: 'no-verification', acknowledgeInsecure: true }
```

Only use this behind a private network boundary or for a provider that cannot
sign its deliveries. Anyone who can reach the endpoint can fire the trigger.

---

## How it composes with the gateway

The gateway already owns the webhook HTTP route, body capture, and signature
checks (`packages/gateway/src/http/control-routes.ts`). This package is the
typed, provider-agnostic descriptor layer over that route: the gateway reads
the `WebhookEndpointDescriptor`/`TriggerDefinition`, resolves the
`CredentialReference`, calls `verifyWebhookRequest`, and turns the verified body
into an `EventEnvelope` via `normalize`. Nothing here re-implements the server.
