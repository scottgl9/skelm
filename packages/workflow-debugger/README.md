# @skelm/workflow-debugger

Ingest a **failed run** and produce a structured, redacted debug report:
identify the failing step, correlate denials / tool failures / retries, attach
evidence references, and — optionally — draft a **reviewable** remediation.

The debugger is **read-only by default**. It fetches a run's timeline, audit
rows, and artifacts through the gateway HTTP API (bearer auth, token by
reference) and analyzes them offline. It never executes a run. Any proposed
source edit is surfaced as a dry-run preview through the gateway's
`dryRun: true` apply route — it is never applied.

## What it analyzes

Given a `runId`, the debugger fetches and correlates:

- **Events** (`GET /runs/:id/events`) — the [run timeline](../../docs/reference/http.md):
  `step.start/complete/error`, `tool.call/result/denied`, `permission.denied`,
  `step.retry`, `run.failed`, …
- **Audit** (`GET /audit?runId=…`) — hash-chained audit rows for the run.
- **Artifacts** (`GET /runs/:id/artifacts`) — workspace-backed evidence.
- **Workflow graph** (`GET /v1/workflows/:id/graph`) — to attach the failing
  step's kind/id/node.

## Failing-step identification

The failing step is the **first `step.error`** in `seq` order (the event log's
deterministic total order), carrying the step's `id` + `kind` and, when the
graph resolves, its `GraphNode`. When no step error was recorded, the debugger
falls back to the `run.failed` error at the run level. It then correlates
`permission.denied`, `tool.denied`, error-shaped `tool.result` payloads, and
`step.retry` into the report and forms a one-line root-cause hypothesis.

## Reviewable-fix model

If you attach an optional `FixProposalTurn` (a native-agent turn, abstracted to
a single `propose()` call), the debugger asks it for a remediation. The draft's
prose is included after redaction. If the draft proposes declarative
[graph edits](../../docs/reference/workflow-graph.md), they are sent to
`POST /v1/workflows/:id/source/apply` with `dryRun: true` and the returned diff
is attached as a **preview**. The report's `suggestedFix` is always
`{ applied: false, reviewable: true }` — a human reviews and applies it, the
debugger never does.

## Redaction

Events and audit rows can carry secret values (a leaked token in an error
message, a bearer header echoed by a failing HTTP tool). **No secret value
reaches the report.** `redactValue` drops values under secret-shaped keys
(`secret`, `token`, `authorization`, `apiKey`, …) and scrubs secret-shaped
substrings (`Bearer …`, `token=…`, provider key prefixes like `sk-…`/`ghp_…`)
from every remaining string. The fix-proposal prose is redacted again at the
boundary in case the model echoed evidence back.

## Usage

```ts
import {
  analyzeFailedRun,
  GatewayDebugHttpClient,
} from '@skelm/workflow-debugger'

const client = new GatewayDebugHttpClient({
  url: 'http://127.0.0.1:14738',
  token: process.env.SKELM_GATEWAY_TOKEN, // resolved from a reference
})

const report = await analyzeFailedRun(runId, client)
console.log(report.failingStep, report.rootCauseHypothesis, report.evidence)
```

`analyzeBundle(bundle, pipelineId, opts, client?)` analyzes an already-fetched
`RunBundle` — useful for tests and offline analysis with no gateway.

## As a workflow package

The package ships `skelm.package.json` with a `default` workflow
(`workflows/debug.workflow.ts`) that takes `{ runId }` and returns the report,
plus a self-test (`workflows/self-test.ts`) that runs the analyze loop on a
canned failed run with no network or LLM.

Permissions default-deny: the workflow declares only the gateway secret it
needs and a narrow loopback `network` ceiling.
