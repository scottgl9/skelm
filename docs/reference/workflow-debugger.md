# Workflow Debugger

`@skelm/workflow-debugger` ingests a **failed run** and produces a structured,
redacted debug report: it identifies the failing step, correlates denials /
tool failures / retries, attaches evidence references, and — optionally — drafts
a **reviewable** remediation.

It is **read-only by default**. It reads a run's timeline, audit rows, and
artifacts through the [gateway HTTP API](./http) (bearer auth, token by
reference) and analyzes them offline. It never executes a run, and any proposed
source edit is surfaced as a dry-run preview — never applied.

## What it analyzes

Given a `runId`, the debugger fetches and correlates:

| Source        | Endpoint                          | Used for |
| ------------- | --------------------------------- | -------- |
| Events        | `GET /runs/:id/events`            | The run timeline (`step.error`, `permission.denied`, `tool.denied`, `tool.result`, `step.retry`, `run.failed`, …). |
| Audit         | `GET /audit?runId=…`              | Hash-chained audit rows for the run. |
| Artifacts     | `GET /runs/:id/artifacts`         | Workspace-backed evidence. |
| Workflow graph| `GET /v1/workflows/:id/graph`     | The failing step's kind/id/[node](./workflow-graph). |

## Failing-step identification

The failing step is the **first `step.error`** in `seq` order — the event log's
deterministic total order — carrying the step's `id` + `kind` and, when the
graph resolves, its `GraphNode`. When no step error was recorded (e.g. a
preamble or finalize failure), the debugger falls back to the `run.failed` error
at the run level.

It then correlates the surrounding signals — `permission.denied`,
`tool.denied`, error-shaped `tool.result` payloads, and `step.retry` — into the
report's `correlations` counts and `evidence` list, and forms a one-line
root-cause hypothesis (a denial upstream points at a missing declared
permission; exhausted retries point at a flaky dependency; and so on).

Every `evidence` entry carries a stable `ref` (`event:<seq>`, the audit seq, or
an artifact id) so a reviewer can pull the exact source material back up.

## Read-only and the reviewable-fix model

The debugger takes **no privileged action**: it reads through the gateway HTTP
surface and analyzes in-process. It does not import the runtime, the run store,
or any enforcement helper — all enforcement and audit stay owned by the gateway.

A remediation is **opt-in**. If you attach a `FixProposalTurn` (a native-agent
turn, abstracted to a single `propose()` call), the debugger asks it for a fix.
The prose is included after redaction. If the draft proposes declarative
[graph edits](./workflow-graph#round-tripping-graph-edits-to-source), they are
sent to `POST /v1/workflows/:id/source/apply` with **`dryRun: true`** and the
returned diff is attached as a preview. The report's `suggestedFix` is always
`{ applied: false, reviewable: true }`: a human reviews and applies it through
the gateway's apply route, the debugger never does.

## Redaction

Events and audit rows can carry secret values — a leaked token in an error
message, a bearer header echoed by a failing HTTP tool. **No secret value
reaches the report.** Redaction:

- drops values under secret-shaped keys (`secret`, `token`, `authorization`,
  `apiKey`, `password`, `clientSecret`, …);
- scrubs secret-shaped substrings from every remaining string — `Bearer …`,
  `token=…`, and provider key prefixes (`sk-…`, `ghp_…`, `xoxb-…`, `AKIA…`);
- re-redacts the fix-proposal prose at the boundary, in case the model echoed
  evidence back.

The `Bearer` scheme word and secret-shaped key names are kept for legibility;
only the secret value is replaced with `[redacted]`.

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
```

`analyzeBundle(bundle, pipelineId, opts, client?)` analyzes an already-fetched
`RunBundle` offline — the path the package's self-test and unit tests exercise
with a fake gateway client and a stub fix turn, with no network or LLM.

## As a workflow package

The package ships `skelm.package.json` with a `default` workflow
(`workflows/debug.workflow.ts`) that takes `{ runId }` and returns the report,
and a self-test (`workflows/self-test.ts`) that runs the analyze loop on a
canned failed run. Permissions default-deny: the workflow declares only the
gateway secret it needs (`SKELM_GATEWAY_TOKEN`, by reference) and a narrow
loopback `network` ceiling.
