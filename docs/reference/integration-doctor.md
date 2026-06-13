---
title: Integration Doctor
---

# Integration Doctor

`@skelm/integration-doctor` is a first-party diagnostic that, given an
[`IntegrationPackageManifest`](/reference/integration-primitives) and the
gateway-supplied probes for privileged checks, produces a structured report
telling an operator whether an integration is actually ready to wire into a
workflow — before a run fails against a misconfigured provider.

It is **generic over the integration-sdk contracts**: it imports no concrete
provider package. It reasons only about the manifest's declared shape (credential
schema, webhook descriptors, mock fixtures) plus a small set of injected probes.

---

## What it checks

Each check yields a `pass`, `warn`, or `fail` plus a one-line summary and, when
not passing, a remediation hint. The report's `overall` status is the worst
per-check status (`fail` > `warn` > `pass`).

- **Credential completeness** — every required field in each `CredentialSchema`
  has a resolvable `CredentialReference`. A missing required field is a `fail`
  with remediation; a missing optional field is a `warn`. Inputs are reference
  **names** only — the doctor never receives a resolved secret value.
- **Provider health** — runs the gateway-supplied `ProviderHealthCheck` (test
  connection). Healthy is `pass`; unhealthy or a throwing probe is `fail`.
- **Webhook verification strategy** — each `WebhookEndpointDescriptor` should
  declare an `hmac`, `signature-header`, or `token` strategy. A `none` strategy
  is a `warn`, because an unverified webhook accepts forged inbound requests.
- **Webhook reachability** — when a webhook probe is supplied, confirms the
  endpoint responds. Unreachable is a `fail`.
- **Credential scopes** — when the caller declares `ScopeRequirement`s and
  supplies a scope probe, the doctor diffs granted against required scopes and
  fails on any missing scope.
- **Rate-limit detection** — reports whether the manifest declares rate-limit
  metadata so operators see when no limit is configured.
- **Mock-fixture replay** — drives the manifest's `MockProviderFixture`s through
  a supplied replay (or counts shipped canned payloads when no replay is given),
  exercising the deterministic CI path.

---

## Generic-over-SDK design

The doctor depends only on `@skelm/integration-sdk`. The privileged work — health
checks, webhook reachability, scope lookup, fixture replay — is delegated to
**probes the gateway injects**, so the doctor itself performs no network or
filesystem I/O. This keeps egress and secret resolution on the trust boundary
(the gateway) and lets the doctor diagnose any integration that exports a
manifest, without ever importing it.

```ts
import { runDoctor } from '@skelm/integration-doctor'

const report = await runDoctor({
  manifest,
  resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
  healthProbe: async () => gateway.testConnection(connectionId),
  webhookProbe: async (ep) => gateway.probeWebhook(ep.path),
  scopeRequirements: [{ credentialSchemaId: 'slack', requiredScopes: ['chat:write'] }],
  scopeProbe: async (id) => gateway.grantedScopes(id),
  mockFixtureReplay: async (f) => gateway.replayFixture(f),
})
```

All probes are optional: omit one and the doctor skips the checks that need it.
The static checks (credential completeness, webhook-verification presence,
rate-limit declaration) always run.

---

## Redaction

A doctor report is shown to operators and may be logged, so it must never carry
a secret value. Two layers enforce this:

1. **References only.** Credential inputs are `CredentialReference`s — names, not
   values — mirroring the SDK invariant that credentials in this surface are
   references resolved by the gateway. The doctor never receives a secret.
2. **Defense in depth.** Every string that reaches the report — including a
   probe's non-secret `detail` field — is scrubbed for token-shaped substrings,
   which are replaced with `[redacted]`. A leaked token in a probe detail cannot
   escape into the report.
