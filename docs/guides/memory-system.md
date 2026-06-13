# Memory system workflows

[`@skelm/memory-system`](https://github.com/scottgl9/skelm/tree/main/packages/memory-system)
is a first-party [workflow package](/reference/workflow-packages) of
memory-management workflows that operate the
[agentmemory](/guides/agentmemory) server under explicit, default-deny
permissions. It turns "long-term agent memory" from a passive store into a
maintained one: rolling up daily activity, summarizing sessions, archiving and
consolidating old memories, promoting valuable ones, and auditing index and
referential health.

Each workflow is a skelm pipeline that calls only the agentmemory operations it
needs and tracks its own cursors and age data in durable
[state](/reference/pipeline-authoring). It installs like any other workflow
package and runs through the gateway — the trust boundary that resolves the
agentmemory token and enforces every permission.

## The workflows

| Workflow | What it does | agentmemory ops required |
|---|---|---|
| `daily-note` | Recalls the day's memories and saves one dated rollup note (idempotent per day). | `recall`, `save` |
| `session-summary` | Recalls a session's memories, summarizes them via an agent turn, saves the summary. | `recall`, `save` |
| `weekly-archive` | Folds memories older than a threshold into a weekly archive memory. | `recall`, `save` |
| `consolidation` | Searches near-duplicate clusters and folds each into one consolidated memory. | `search`, `save` |
| `promotion` | Re-saves high-scoring memories under a `promoted` concept (once each). | `recall`, `save` |
| `stale-prune` | Reports stale-memory candidates to state. **Read-only — never deletes.** | `recall` |
| `search-health` | Probes the search index with canary queries and records a health snapshot. | `search` |
| `integrity-audit` | Flags empty memories and dangling knowledge-graph edges. | `recall`, `graph` |

Age- and staleness-based workflows derive timestamps from durable state rather
than the recall payload, so a memory is only ever archived or flagged once skelm
has observed it long enough — the recall hit itself carries no reliable age.

## Permissions are default-deny

Each workflow declares exactly the [agentmemory operations](/reference/permissions#agentmemory)
it uses. Every other operation is omitted, and the runtime treats an omitted
agentmemory flag as **deny**. The read-only workflows — `stale-prune`,
`search-health`, `integrity-audit` — declare no `allowSave`, so the gateway
hands them a memory handle whose `save` short-circuits to a denied no-op. They
report findings to state; acting on those findings (deletion) is a separate,
operator-gated step, never an implicit side effect of the audit.

The package needs one secret, `AGENTMEMORY_TOKEN` (the bearer token for the
agentmemory server). It is declared by name only in the manifest and granted per
workflow through `allowedSecrets`; the gateway resolves the value at run time
and it never reaches the manifest, logs, audit, or state.

## Triggers are offered, disabled by default

The manifest offers a `cron` trigger per workflow, but — like every workflow
package — **triggers are offered, never armed.** Each one is disabled until an
operator explicitly enables it, and the pipeline entrypoints arm no triggers
themselves. Enable a schedule the same way you enable any package trigger,
through the gateway.

## Configuration

Every knob is bounded with safe defaults so a workflow never fans out unbounded
against the server: `project`, `recallLimit`, `staleAfterMs`, `archiveAfterMs`,
`duplicateScore`, `promoteScore`, and `summaryMaxTokens`.

## Testing without a backend

The workflow logic is exported as plain functions over an injectable
dependency bag (`{ memory, state, project, summarizer?, now?, log? }`), and the
package ships deterministic fakes. `makeFakeMemory(workflow, opts)` wraps a
recording backend in the real `createAgentmemoryHandle` enforcement layer for
the workflow's declared ceiling, so the default-deny tests exercise the genuine
`TrustEnforcer` path instead of mocking it. See the package
[README](https://github.com/scottgl9/skelm/tree/main/packages/memory-system) for
the exported surface.
