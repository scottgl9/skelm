# WorkflowGraph

The **WorkflowGraph** is a read-only AST derived from a pipeline or persistent
workflow. It is the public contract consumed by the dashboard graph viewer and
the future visual block editor.

The authored **TypeScript stays the single source of truth.** The graph is
always *re-derived* from the workflow; it is never edited in place and never
round-tripped back into source. `deriveWorkflowGraph()` is pure and
deterministic — the same workflow always yields an identical graph — and never
serializes an author function or a secret value.

## Producing a graph

- **Library:** `deriveWorkflowGraph(workflow)` from `@skelm/core` returns a
  `WorkflowGraph` for a `Pipeline` or a `PersistentWorkflow`.
- **CLI:** `skelm describe <workflow> --format graph-json` prints the graph as
  JSON. The CLI is a thin client; the gateway derives the graph and returns it.
- **HTTP:** `GET /v1/workflows/:id/graph` returns the graph for a registered
  workflow (bearer-authed like other workflow routes; read-only, not audited).

## Schema

### `WorkflowGraph`

| Field     | Type                               | Notes |
| --------- | ---------------------------------- | ----- |
| `id`      | `string`                           | Workflow id. |
| `version` | `string?`                          | Declared version, when set. |
| `kind`    | `'pipeline' \| 'persistent-workflow'` | |
| `nodes`   | `GraphNode[]`                      | Top-level nodes in step order. |
| `edges`   | `GraphEdge[]`                      | Control / data edges between node ids. |
| `meta`    | `Record<string, unknown>?`         | E.g. `{ hasFinalize: true }`. |

### `GraphNode`

| Field         | Type                          | Notes |
| ------------- | ----------------------------- | ----- |
| `id`          | `string`                      | |
| `kind`        | `GraphNodeKind`               | A `StepKind`, or `trigger` / `finalize`. |
| `label`       | `string?`                     | |
| `summary`     | `string?`                     | |
| `permissions` | `AgentPermissionsSummary?`    | Redacted; see below. |
| `codeOwned`   | `boolean?`                    | See [codeOwned semantics](#codeowned-semantics). |
| `children`    | `GraphNode[]?`                | Nested sub-steps for control-flow containers. |
| `data`        | `Record<string, unknown>?`    | Small, kind-specific, serializable detail. |

Control-flow containers nest their sub-steps in `children`:

- `parallel` → each child step.
- `branch` → one child per case (case name in the child's `data.case`) plus the
  `default` child labelled `default`.
- `forEach` → no children (the per-item body is built lazily by an author
  factory and cannot be described statically).
- `loop` → the loop body, with `data.maxIterations`.
- `pipelineStep` → the nested pipeline's steps, with `data.pipelineId`.
- `idempotent` → the wrapped step.

For a **persistent workflow**, the preamble steps appear in order followed by a
terminal `turn` node (`kind: 'agent'`).

### `GraphEdge`

| Field   | Type                  | Notes |
| ------- | --------------------- | ----- |
| `from`  | `string`              | Source node id. |
| `to`    | `string`              | Target node id. |
| `kind`  | `'control' \| 'data'` | Sequential step order is `control`. |
| `label` | `string?`             | |

The MVP emits sequential `control` edges between top-level nodes; data edges are
reserved for a later slice.

### `AgentPermissionsSummary`

A **redacted** view of a step's declared permissions:

| Field                | Type        | Notes |
| -------------------- | ----------- | ----- |
| `dimensions`         | `string[]`  | Which permission dimensions are declared (e.g. `tool`, `executable`, `network`). |
| `profile`            | `string?`   | Named project permission profile. |
| `executableProfiles` | `string[]?` | Named executable profiles referenced. |

The summary carries **only** dimension labels plus profile names. It never
includes secret values, allowed hosts, filesystem paths, tool ids, or executable
binary names — a read-only graph has no business surfacing operational secrets.

## `codeOwned` semantics

A node is `codeOwned: true` when it wraps arbitrary author code that cannot be
safely round-tripped to TypeScript source:

- a `code` step with an inline `run` function (a `module`-backed `code` step is
  *not* code-owned — its `data.module` path is stable);
- a `branch` step (its `on` discriminator is an author predicate);
- a `loop` step (its `while` predicate is author code);
- a `forEach` step (its `items` selector and per-item `step` factory are author
  functions).

The future visual block editor **must never rewrite a `codeOwned` region**. The
TypeScript source remains authoritative for those regions; the editor may only
reshape the structural, non-code-owned parts of the graph.
