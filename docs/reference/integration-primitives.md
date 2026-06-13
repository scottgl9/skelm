---
title: Integration Primitives
---

# Integration Primitives

`@skelm/integration-sdk` ships the universal contracts every integration
package builds on: a conversation-adapter standard, a credential model, provider
registry contracts, health/test contracts, the shared delivery target, a set of
tested action/trigger helpers, and the integration-package manifest. These are
TypeScript types plus a few small, dependency-free helpers — concrete provider
adapters live in later `@skelm/integration-*` and `@skelm/provider-*` packages.

---

## Credential references are references only

The single most important invariant: **credentials in the SDK are references,
never values.** A `CredentialSchema` declares which secrets an integration needs
(by name and shape); a `CredentialReference` names one secret by its
`secretName`. Neither type can carry a value. Secret resolution is owned by the
gateway — it resolves references to ephemeral values at dispatch and never
persists them. Integration packages must not read `process.env` for secrets and
must not persist secret values.

```ts
import type { CredentialReference, Connection } from '@skelm/integration-sdk'

const tokenRef: CredentialReference = {
  kind: 'credential-ref',
  secretName: 'SLACK_BOT_TOKEN', // a name, never the token itself
}
```

The reference type is closed — it has no `value` field and no index signature —
so a value-bearing object is not assignable where a reference is expected. For
boundaries that receive `unknown` input, `assertNoSecretValue()` throws at
runtime if a forbidden value-bearing field (`value`, `secret`, `token`,
`password`, `apiKey`, `accessToken`) is present.

A `Connection` is a credential-backed identity: it lists the `CredentialReference`s
that authenticate it plus non-secret metadata. The gateway resolves the
references when it hands an adapter an authenticated transport.

---

## Conversation adapter contract

`ConversationAdapter` is the normalized surface every chat/messaging integration
(Discord, Matrix, Slack, Telegram, …) implements. It has a small set of
**required** operations every provider must support and **optional** capability
operations a provider advertises through its `CapabilityDescriptor`.

Required: `connect`, `disconnect`, `sendMessage`, `sendTyping`, `getTargetInfo`,
and `onInbound` (normalized inbound-event subscription).

Optional (present only when the matching `CapabilityDescriptor` flag is set):
`editMessage`, `deleteMessage`, `replyInThread`, `addReaction`/`removeReaction`,
`registerCommands`, and `sendImage`/`sendFile`/`sendVoice`/`sendVideo`.

Inbound and outbound traffic is normalized through `InboundEvent`,
`OutboundEvent`, and `MediaAttachment`. The gateway and dashboard read the
`CapabilityDescriptor` to validate workflows and render a capability matrix;
provider-specific behavior lives behind the optional ops and the descriptor's
`escapeHatches` (Block Kit, inline keyboards, …).

---

## Provider registry contracts

Providers are split into typed categories — `ModelProvider`, `ToolProvider`,
`MediaProvider`, `BrowserProvider`, `MemoryProvider`, `SecretProvider` — sharing
a `ProviderBase` (identity, required credential references, optional
cost/latency metadata, and a `health()` check). A `ProviderRegistry` looks them
up by category and id.

`BrowserProvider` here is the registry-level contract; it wraps a `BrowserDriver`
(the low-level navigate/click/type/screenshot/extract surface that
`@skelm/agent`'s browser tools drive under gateway-enforced network egress).
`BrowserDriver` is a structural mirror of the agent's `BrowserProvider`
interface, so the agent driver satisfies it without the SDK depending on the
agent package. Permission enforcement stays in the agent tool wrappers and the
gateway — drivers and providers perform no enforcement themselves.

---

## Health and test contracts

- `ProviderHealthCheck` — the result of a liveness/credential check (no secret
  values in `detail`).
- `MockProviderFixture` — canned provider payloads a package ships for
  deterministic CI.
- `LiveTestDescriptor` — an opt-in live test gated on `requiredEnv`
  (conventionally `SKELM_LIVE_*`). `shouldRunLiveTest()` returns true only when
  every required env var is present and non-empty, so default CI never fails on
  absent credentials.

---

## Delivery target

`DeliveryTarget` is re-exported from `@skelm/core` — there is exactly one
canonical shape (`{ kind, target, metadata? }`) shared by tasks, HITL gates,
notifications, cron/scheduled runs, and final artifacts. The SDK reconciles with
core rather than duplicating it.

---

## Universal helpers

Real, tested primitives integration packages reuse:

- `verifyHmacSignature()` — constant-time HMAC verification (configurable
  algorithm/prefix/encoding) generalizing the Slack signature approach.
- `httpRequest()` — an HTTP helper that consults a required `EgressPolicy` hook
  and refuses denied hosts; it neither resolves credential references nor reads
  `process.env`.
- `normalizeWebhook()` / `EventEnvelope` — a normalized envelope (with a stable
  derived id when the provider supplies none).
- `paginate()` — cursor-based pagination to exhaustion.
- `withRetry()` / `backoffDelay()` — exponential backoff with optional jitter
  and a retryability predicate.
- `RateLimiter` — a sliding-window limiter.
- `IdempotencyTracker` — per-process duplicate suppression within a TTL.

---

## Integration-package manifest

`IntegrationPackageManifest` is the declarative surface an integration package
exposes **at runtime**: actions, triggers, conversation-adapter capability
descriptors, credential requirements (by reference only), required
permissions/executable profiles, webhook endpoints and their verification
strategy, supported events/media, dashboard setup metadata, mock fixtures,
live-test descriptors, and an audit redaction policy.

This is distinct from the JSON `skelm.package.json`
(`WorkflowPackageManifest`), which is the on-disk trust boundary parsed *before*
any package code runs and can hold only JSON-serializable, statically-validated
metadata. The integration manifest describes code-level objects (adapter
instances, functions, fixtures) that cannot live in JSON. The two are
complementary: the JSON manifest gates loading; the integration manifest
describes the loaded integration's capabilities.
