# @skelm/memory-system

First-party **memory-management workflows** for skelm, built on the
[`@skelm/agentmemory`](../agentmemory) client and skelm's durable
[state](../core) primitives. The package is a
[workflow package](../../docs/reference/workflow-packages.md): a `skelm.package.json`
manifest plus pipeline entrypoints, installed explicitly into a project.

Each workflow operates the agentmemory server under an explicit, **default-deny**
permission ceiling and tracks its own cursors/age data in durable state. Nothing
is scheduled until an operator enables a trigger.

## Workflows

| Workflow | What it does | agentmemory ops it needs |
|---|---|---|
| `daily-note` | Recalls the day's memories and saves one dated rollup note (idempotent per day). | `recall`, `save` |
| `session-summary` | Recalls one session's memories, summarizes them via an agent turn, saves the summary. | `recall`, `save` |
| `weekly-archive` | Folds memories older than a threshold into a weekly archive memory. | `recall`, `save` |
| `consolidation` | Searches near-duplicate clusters and folds each into one consolidated memory. | `search`, `save` |
| `promotion` | Re-saves high-scoring memories under a `promoted` concept (once each). | `recall`, `save` |
| `stale-prune` | Reports stale-memory candidates to state. **Read-only — no deletion.** | `recall` |
| `search-health` | Probes the search index with canary queries and records a health snapshot. | `search` |
| `integrity-audit` | Flags empty memories and dangling graph edges. | `recall`, `graph` |

The age- and staleness-based workflows derive timestamps from durable state, not
from the agentmemory recall payload (which carries no reliable age), so a memory
is only acted on once skelm itself has observed it long enough.

## Permissions are default-deny

Every workflow declares exactly the agentmemory operations it uses; every other
operation is `undefined`, which the runtime treats as **deny**. A workflow whose
ceiling omits `allowSave` (e.g. `stale-prune`, `search-health`,
`integrity-audit`) receives a handle whose `save` short-circuits to a denied
no-op — it physically cannot write, even if its code asks. The ceilings live in
`WORKFLOW_PERMISSIONS` and are mirrored in the manifest's per-workflow
`permissions` blocks.

The single secret the workflows need — `AGENTMEMORY_TOKEN`, the bearer token for
the agentmemory server — is declared by name only in the manifest and granted
per workflow via `allowedSecrets`. The value is resolved by the gateway at run
time and never appears in the manifest, logs, or state.

## Triggers are offered, disabled by default

The manifest offers a `cron` trigger per workflow, but per the workflow-package
convention **every trigger is disabled until an operator explicitly enables it**.
The pipeline entrypoints themselves arm no triggers.

## Configuration

`MemorySystemConfigSchema` (Zod, strict) bounds every knob: `project`,
`recallLimit`, `staleAfterMs`, `archiveAfterMs`, `duplicateScore`,
`promoteScore`, `summaryMaxTokens`. All have safe defaults so a workflow never
fans out unbounded against the server.

## Using the logic directly

The workflow logic is exported as plain functions over an injectable
`MemorySystemDeps` (`{ memory, state, project, summarizer?, now?, log? }`), so
they can be embedded, scheduled, or tested without a live backend:

```ts
import { runDailyNote, resolveMemorySystemConfig } from '@skelm/memory-system'

const out = await runDailyNote(
  { memory, state, project: 'my-project' },
  resolveMemorySystemConfig(),
)
```

## Testing

The `testing` module (`src/testing.ts`) ships deterministic
fakes: `makeFakeMemory(workflow, opts)` wraps a recording backend in the **real**
`createAgentmemoryHandle` enforcement layer for the workflow's declared ceiling,
`makeFakeState(seed)` is an in-memory `State`, and `fixedClock(at)` pins time.
Because the fake routes through the real `TrustEnforcer`, the default-deny tests
prove enforcement rather than mocking it. The package self-test
(`runSelfTest()`) runs `daily-note` and the read-only `stale-prune` deny path
against these fakes.
