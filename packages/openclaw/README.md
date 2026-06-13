# @skelm/openclaw

A **host bridge** that lets an OpenClaw-style host run, inspect, cancel, and
audit skelm workflows. The bridge exposes OpenClaw-style tools that map onto
skelm's **gateway HTTP API**.

The bridge is a **thin typed client**, not a reimplementation of the gateway.
The gateway remains the single trust boundary: it owns permission enforcement,
secret resolution, and audit. The bridge only forwards calls and reshapes
responses.

---

## Installation

```bash
pnpm add @skelm/openclaw @skelm/core @skelm/integration-sdk
```

---

## The bridge tools

Each tool is a thin mapping onto one or a few gateway HTTP routes:

| Tool                    | Gateway route(s)                                          | Purpose                              |
| ----------------------- | --------------------------------------------------------- | ------------------------------------ |
| `skelm_run`             | `POST /pipelines/:id/run`                                 | Run a workflow synchronously         |
| `skelm_start`           | `POST /v1/tasks`                                          | Start a detached, tracked task       |
| `skelm_status`          | `GET /v1/tasks/:id` or `GET /runs/:id/events`             | Status of a task or run              |
| `skelm_cancel`          | `POST /v1/tasks/:id/cancel` or `DELETE /runs/:id`         | Cancel a task or run                 |
| `skelm_audit`           | `GET /audit`                                              | Query hash-chained audit references  |
| `skelm_workflow_search` | `GET /pipelines`                                          | List or find registered workflows    |

Every tool returns a normalized `ToolResult`:

```ts
interface ToolResult<T> {
  ok: boolean
  data: T
  refs: { runId?: string; taskId?: string; auditQuery?: Record<string, string> }
}
```

`refs` carries the **run / task / audit references** so a host can correlate the
result with its audit trail and re-query `/audit`.

---

## Credentials are by reference

The bridge authenticates to the gateway with a **bearer token, supplied by
reference** — a `CredentialReference` naming the secret, never the value. The
bridge never reads `process.env` for secrets and never logs the token. A
host-supplied `resolveBearer` callback resolves the reference to an ephemeral
token at request time; the token lives only inside the `Authorization` header.

```ts
import { createGatewayClient } from '@skelm/openclaw'

const client = createGatewayClient({
  baseUrl: 'http://127.0.0.1:14738',
  bearer: { kind: 'credential-ref', secretName: 'SKELM_GATEWAY_TOKEN' },
  resolveBearer: (ref) => host.resolveSecret(ref.secretName), // gateway/host-owned
})
```

A `401`/`403` from the gateway surfaces as `GatewayAuthError` — with no token in
the message.

---

## Inbound → run → deliver

An inbound OpenClaw message (a conversation-adapter `InboundEvent`) is
normalized into a flat workflow input, preserving the originating channel as a
canonical `DeliveryTarget`:

```ts
import { normalizeInbound, skelmRun, deliverResult } from '@skelm/openclaw'

const { input, deliveryTarget } = normalizeInbound(inboundEvent)
const result = await skelmRun(client, { workflowId: 'hello.workflow.ts', input })

// Deliver the result back to the originating channel; audit refs ride along
// in providerOptions.skelmRefs so the reply stays correlated to the run.
await deliverResult(send, result, deliveryTarget)
```

`deliverResult` reshapes the result into a conversation-adapter `OutboundEvent`
and hands it to a caller-supplied sink (an `@skelm/integration-sdk` adapter, the
OpenClaw host, or a test fake). The run / task / audit references are preserved
**end-to-end**, from the inbound message through the run to the delivered reply.

---

## Testing

The package ships a `FakeGatewayClient` (the same `GatewayHttpClient` seam
production uses, with a scripted transport) and a `runSelfTest()` that exercises
a representative run → status → deliver loop with no real gateway and no
network:

```ts
import { runSelfTest } from '@skelm/openclaw'

const report = await runSelfTest()
// { runId, delivered, auditPreserved: true }
```

---

## Manifest

`openclawManifest` is the declarative surface (the six tool actions and the
single by-reference bearer credential) a host reads to register the bridge. Its
`auditRedaction` policy keeps the resolved bearer out of any audit row.
