# @skelm/integration-doctor

> Diagnostic doctor for [skelm](https://github.com/scottgl9/skelm) integrations.

[![npm](https://img.shields.io/npm/v/@skelm/integration-doctor)](https://www.npmjs.com/package/@skelm/integration-doctor)

Part of [skelm](https://github.com/scottgl9/skelm).

Given an `IntegrationPackageManifest` from `@skelm/integration-sdk` (plus the
gateway-supplied probes for the privileged checks), the doctor produces a
structured report so an operator can see — before they wire a workflow to a
provider — whether the integration is actually ready.

## What it checks

| Check | Status semantics |
| --- | --- |
| **Credential completeness** | Every required field in each `CredentialSchema` has a resolvable credential reference. Missing required → `fail` with remediation; missing optional → `warn`. |
| **Provider health** | Runs the gateway-supplied `ProviderHealthCheck` (test connection). Healthy → `pass`; unhealthy or throwing → `fail`. |
| **Webhook verification** | Each `WebhookEndpointDescriptor` declares an hmac / signature-header / token strategy. `verification: 'none'` → `warn`. |
| **Webhook reachability** | When a probe is supplied, confirms the endpoint responds. Unreachable → `fail`. |
| **Credential scopes** | When the caller declares `ScopeRequirement`s and supplies a scope probe, diffs granted vs. required scopes. Missing → `fail`. |
| **Rate-limit detection** | Reports whether the manifest declares rate-limit metadata. |
| **Mock-fixture replay** | Drives the manifest's `MockProviderFixture`s through a supplied replay (or counts shipped payloads when no replay is given). |

The worst per-check status becomes the report's `overall` (`fail` > `warn` > `pass`).

## Generic over the SDK contracts

The doctor depends on **no concrete provider package**. It reasons only about
the `@skelm/integration-sdk` contracts — a manifest, its declared credential
schema, webhook descriptors, mock fixtures — and a small set of injected probes.
Any integration that exports an `IntegrationPackageManifest` is diagnosable
without the doctor importing it.

The doctor performs **no network or filesystem I/O itself**. Privileged work
(health checks, webhook reachability, scope lookup) is delegated to probes the
gateway supplies, keeping egress and secret resolution where they belong — on
the trust boundary.

## Redaction

A report is shown to operators and may be logged, so it must never carry a
secret value. Credential inputs are **references (names) only** — the doctor
never receives a resolved secret. As defense in depth, every string that reaches
a report (including a probe's `detail`) is scrubbed: token-shaped substrings are
replaced with `[redacted]`.

## Quick start

```ts
import { runDoctor } from '@skelm/integration-doctor'

const report = await runDoctor({
  manifest, // an IntegrationPackageManifest
  resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
  healthProbe: async () => gateway.testConnection(connectionId),
  webhookProbe: async (ep) => gateway.probeWebhook(ep.path),
  scopeRequirements: [{ credentialSchemaId: 'slack', requiredScopes: ['chat:write'] }],
  scopeProbe: async (id) => gateway.grantedScopes(id),
  mockFixtureReplay: async (f) => gateway.replayFixture(f),
})

for (const c of report.checks) {
  console.log(`${c.status.toUpperCase()} ${c.id}: ${c.summary}`)
  if (c.remediation) console.log(`  → ${c.remediation}`)
}
```

All probes are optional: omit a probe and the doctor simply skips the checks
that depend on it (credential completeness, webhook-verification presence, and
rate-limit declaration are static and always run).

## Self-test

`pnpm --filter @skelm/integration-doctor self-test` builds the package and runs
the doctor against a synthetic manifest, asserting each status and that no
secret value escapes into the report.
