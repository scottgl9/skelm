---
title: OpenClaw Host Bridge
---

# OpenClaw Host Bridge (`@skelm/openclaw`)

`@skelm/openclaw` is a **host bridge**: it lets an OpenClaw-style host run,
inspect, cancel, and audit skelm workflows by exposing OpenClaw-style tools that
map onto the gateway [HTTP API](./http). The bridge is a **thin typed client**,
not a reimplementation of the gateway — the gateway remains the single trust
boundary that owns permission enforcement, secret resolution, and audit.

## The bridge tools

Each tool maps onto one or a few gateway routes and returns a normalized
`ToolResult` (`{ ok, data, refs }`) whose `refs` carries the run / task / audit
references.

| Tool                    | Gateway route(s)                                  | Purpose                             |
| ----------------------- | ------------------------------------------------- | ----------------------------------- |
| `skelm_run`             | `POST /pipelines/:id/run`                         | Run a workflow synchronously        |
| `skelm_start`           | `POST /v1/tasks`                                  | Start a detached, tracked task      |
| `skelm_status`          | `GET /v1/tasks/:id` · `GET /runs/:id/events`      | Status of a task or run             |
| `skelm_cancel`          | `POST /v1/tasks/:id/cancel` · `DELETE /runs/:id`  | Cancel a task or run                |
| `skelm_audit`           | `GET /audit`                                      | Query hash-chained audit references |
| `skelm_workflow_search` | `GET /pipelines`                                  | List or find registered workflows   |

`skelm_run` returns a run's final state; `skelm_start` creates a tracked
[detached task](./http#tasks-lineage-v1-tasks-v1-lineage) and surfaces both its
`taskId` and the `childRunId`.

## Wiring it into an OpenClaw host

1. **Construct a gateway client.** The bridge talks only through a
   `GatewayHttpClient` seam. The default `createGatewayClient` is `fetch`-backed;
   tests inject a `FakeGatewayClient` instead.

   ```ts
   import { createGatewayClient } from '@skelm/openclaw'

   const client = createGatewayClient({
     baseUrl: 'http://127.0.0.1:14738',
     bearer: { kind: 'credential-ref', secretName: 'SKELM_GATEWAY_TOKEN' },
     resolveBearer: (ref) => host.resolveSecret(ref.secretName),
   })
   ```

2. **Register the tools.** Read `openclawManifest` to register the six tool
   actions and the single by-reference credential the bridge declares.

3. **Map inbound → run → deliver.** Normalize an inbound message, run it, and
   deliver the result back to the originating channel (see below).

## Credential reference and redaction

The bridge authenticates with a **bearer token by reference** — a
`CredentialReference` ([credential model](./integration-primitives)) naming the
secret, never the value. The bridge never reads `process.env` for secrets and
never logs the token: a host-supplied `resolveBearer` callback resolves the
reference to an ephemeral token at request time, and the token lives only inside
the `Authorization` header. A `401`/`403` surfaces as `GatewayAuthError` with no
token in the message. The manifest's `auditRedaction` policy keeps the resolved
bearer out of any audit row.

## Inbound, outbound, and audit-ref preservation

`normalizeInbound` turns an OpenClaw conversation-adapter `InboundEvent` into a
flat, JSON-serializable trigger input and preserves the originating channel as a
canonical [`DeliveryTarget`](./integration-primitives#delivery-target):

```ts
import { normalizeInbound, skelmRun, deliverResult } from '@skelm/openclaw'

const { input, deliveryTarget } = normalizeInbound(inboundEvent)
const result = await skelmRun(client, { workflowId: 'hello.workflow.ts', input })
await deliverResult(send, result, deliveryTarget)
```

`deliverResult` reshapes the result into a conversation-adapter `OutboundEvent`
and hands it to a caller-supplied delivery sink. The run / task / audit
references ride along in `providerOptions.skelmRefs`, so the reply stays
correlated to the run **end-to-end** — from the inbound message through the run
to the delivered reply.

## Deterministic testing

The package ships a `FakeGatewayClient` — the same seam production uses, driven
by a route → response map — and a `runSelfTest()` that exercises a
representative run → status → deliver loop with no real gateway and no network.

## See also

- [Gateway HTTP reference](./http) — the routes the bridge calls.
- [Integration Primitives](./integration-primitives) — credential references,
  the conversation-adapter contract, and the shared `DeliveryTarget`.
