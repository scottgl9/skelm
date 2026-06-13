---
title: Webhook Trigger
---

# Generic Webhook Trigger (`@skelm/integration-webhook`)

`@skelm/integration-webhook` is a generic inbound webhook trigger built on the
[Integration Primitives](./integration-primitives). It supplies the typed pieces
the gateway composes with its inbound webhook HTTP surface — a trigger
definition, an endpoint descriptor, a signature-verification strategy, and an
event normalizer. **It does not run an HTTP server**: the gateway owns the
inbound webhook route and secret resolution.

---

## What it provides

- A typed `TriggerDefinition` (`kind: 'webhook'`) plus a
  `WebhookEndpointDescriptor` the gateway registers.
- A `WebhookVerification` strategy — **HMAC** keyed by a `CredentialReference`,
  or an explicit, clearly-marked **insecure no-verification** mode.
- `normalizeWebhookRequest` / `WebhookTrigger.normalize`, which map the raw
  request into the SDK `EventEnvelope` using configurable header/body field
  mappings (with a derived stable id for dedupe when the provider sends none).
- `buildWebhookManifest`, producing an `IntegrationPackageManifest` with the
  trigger, endpoint, credential references, dashboard metadata, a
  `MockProviderFixture` of canned payloads, and an audit redaction policy.

---

## Verification strategy contract

```ts
type WebhookVerification =
  | {
      strategy: 'hmac'
      signatureHeader: string          // e.g. 'x-hub-signature-256'
      secretRef: CredentialReference   // signing secret by name — never a value
      algorithm?: 'sha1' | 'sha256' | 'sha512'
      prefix?: string                  // e.g. 'sha256='
      encoding?: 'hex' | 'base64'
    }
  | { strategy: 'no-verification'; acknowledgeInsecure: true }
```

`verifyWebhookRequest` returns a discriminated result:

```ts
{ ok: true; strategy }
| { ok: false; reason: 'missing-signature' | 'signature-mismatch' }
```

### Security model

- **Signing secret by reference only.** The signing secret is named with a
  `CredentialReference`. This package never reads `process.env`, never holds the
  value, and never logs or throws it. The gateway resolves the reference to an
  ephemeral value and passes it as `resolvedSecret`.
- **Default-deny.** HMAC verification **rejects** an absent/empty signature
  (`missing-signature`) and any digest mismatch (`signature-mismatch`,
  constant-time via `verifyHmacSignature`). With no resolved secret it fails
  closed rather than throwing.
- **Explicit insecure opt-in.** Skipping verification requires
  `{ strategy: 'no-verification', acknowledgeInsecure: true }` — it can never be
  selected by omission.
- **Redaction.** The manifest redaction policy always names the signature
  header so its value cannot reach audit rows or logs.

---

## Composing with the gateway

The gateway already owns the inbound webhook HTTP route, raw-body capture, and
signature checking (`packages/gateway/src/http/control-routes.ts`). This package
is the provider-agnostic, typed descriptor layer over that route:

1. The gateway reads the `WebhookEndpointDescriptor` / `TriggerDefinition` from
   the package manifest and registers the path.
2. On an inbound POST it resolves the `CredentialReference` and calls
   `verifyWebhookRequest({ verification, rawBody, header, resolvedSecret })`.
3. On `ok: true` it calls `trigger.normalize({ header, body })` to obtain the
   `EventEnvelope`, then dispatches the run. The envelope id feeds idempotency
   (`IdempotencyTracker`) and audit.

```ts
import {
  defineWebhookTrigger,
  buildWebhookManifest,
  verifyWebhookRequest,
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
  normalization: {
    type: { bodyPath: 'event.type' },
    id: { bodyPath: 'event.id' },
    metadataHeaders: { deliveryId: 'x-delivery-id' },
  },
  events: ['event.created', 'event.updated'],
})

export const manifest = buildWebhookManifest({ trigger })
```

---

## Field mapping

`normalization` maps fields out of the request into the envelope. A header
mapping wins over a body mapping for the same field; a missing `type` falls back
to `defaultEventType` (then `'webhook'`), and a missing `id` is derived from the
payload so dedupe still works.

| Envelope field | Source |
| --- | --- |
| `type` | `normalization.type` (header or dotted body path) |
| `id` | `normalization.id` (header or dotted body path); derived when absent |
| `metadata` | `normalization.metadataHeaders` (envelope key → request header) |
| `payload` | the raw parsed body |
