# WorkflowGraph

The **WorkflowGraph** is a read-only AST derived from a pipeline or persistent
workflow. It is the public contract consumed by the dashboard graph viewer and
the future visual block editor.

The authored **TypeScript stays the single source of truth.** The graph is
always *re-derived* from the workflow; it is never edited in place.
`deriveWorkflowGraph()` is pure and deterministic — the same workflow always
yields an identical graph — and never serializes an author function or a
secret value. Visual edits flow the other way: a small set of declarative
[graph edits](#round-tripping-graph-edits-to-source) is applied to the
TypeScript source as a reviewable patch, and the graph is then re-derived.

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

The visual block editor **must never rewrite a `codeOwned` region**. The
TypeScript source remains authoritative for those regions; the editor may only
reshape the structural, non-code-owned parts of the graph.

## Round-tripping graph edits to source

`applyGraphEdits(source, edits)` from `@skelm/core` turns declarative graph
edits into a reviewable patch against the workflow's TypeScript source. The
TypeScript stays the single source of truth: edits are applied as targeted
text splices over the parsed AST (the `typescript` compiler API), never as a
full re-emit, so formatting and comments outside the edited spans are
preserved byte-for-byte.

### `GraphEdit`

A small union of safe, declarative edits — nothing else is expressible:

| Kind           | Shape                                              | Effect |
| -------------- | -------------------------------------------------- | ------ |
| `reorderSteps` | `{ pipelineId, orderedStepIds }`                   | Permute the top-level `steps` array. Elements move verbatim, so code-owned steps may be reordered. |
| `setStepField` | `{ stepId, field, value }`                         | Set a declarative field to a JSON-serializable literal. Per-kind whitelist (e.g. `infer`: `backend`/`model`/`temperature`/`maxTokens`/`prompt`/`system`; `wait`: `message`/`timeoutMs`; `invoke`: `pipelineId`/`input`; module-backed `code`: `module`/`export`/`timeoutMs`). |
| `addStep`      | `{ afterStepId?, step: DeclarativeStepSpec }`      | Insert a generated builder call. Only declaratively-expressible steps: `wait`, `invoke`, `infer` / `agent` with literal config, and `code` with a `module:` path — never an inline `run`. The named import from `skelm` / `@skelm/core` is augmented when needed. |
| `removeStep`   | `{ stepId }`                                       | Remove a top-level step that carries **no** author code. |

### Result and refusal semantics

`applyGraphEdits` returns
`{ ok: true, source, diff }` — the full modified source plus a unified diff
for preview — or `{ ok: false, reason, detail }` with `reason` one of:

- **`code-owned`** — the edit targets or would alter a code-owned region:
  `setStepField` on a `branch` / `loop` / `forEach` step or a `code` step with
  an inline `run`; any field that holds author code (`run`, `on`, `while`,
  `items`, `step`, `when`, …); or `removeStep` of a step whose source carries
  any function. These regions require **manual TypeScript editing** — the
  round-trip never rewrites them.
- **`unsupported`** — the edit cannot be represented safely: non-whitelisted
  fields, step-id renames, non-literal values, ambiguous step ids, comments
  between steps that a splice would drop, a spec smuggling extra fields, etc.
- **`not-found`** / **`invalid-source`** — unknown step/pipeline id; source
  that does not parse.

Every `ok: true` result is verified before it is returned: the emitted source
must parse, and **every author function in the input must appear
byte-identically in the output** (relocation by `reorderSteps` is the only
permitted change). `applyGraphEdits` never emits source it cannot guarantee is
equivalent to the input except for the intended edit.

### Applying edits through the gateway

`POST /v1/workflows/:id/source/apply` (bearer-authed) is the only write path.
Body: `{ edits: GraphEdit[], dryRun?: boolean }`.

Edits target the workflow's **executable source**. For `managed` and
`archive` registrations that is the gateway-owned managed copy — the author's
original file (`originPath`) is metadata only and is never touched. For
legacy `path` registrations and glob-discovered workflows the authored host
file is the executable, source-controlled truth and is edited in place.

- **`dryRun` defaults to `true`** — a request that does not explicitly send
  `dryRun: false` never writes; it returns `{ ok, applied: false, dryRun:
  true, diff }` for preview.
- The executable source path is re-validated against the allowed registration
  roots (realpath, same check as `POST /v1/workflows/register`) on every call;
  escapes are refused and the denial is audited.
- The generated source is validated **before any write** by loading it through
  the gateway's workflow loader (a probe file in the same directory, so
  relative imports resolve identically). A refusal or load failure returns
  `422` with nothing written and no revision created.
- `dryRun: false` against a managed copy **cuts a new managed revision**: the
  current managed tree is re-materialized with the edited entry file, the
  registration record's `sourcePath` is repointed at the new revision entry,
  and the registry follows — new runs use the edit while in-flight runs keep
  resolving their (retained) old revision. The response carries the new
  `revision` id.
- `dryRun: false` against a `path` workflow rewrites the host file atomically
  (temp file + rename).
- Every apply appends a `workflow.source.apply` audit event carrying the
  workflow id, source kind, edit count, and (for managed copies) the new
  revision id — never the source body or any path outside gateway control.

When the gateway materializes a managed copy it follows symlinks **only if
their target resolves inside the source root** (`realpath` checked against the
root, same no-escape rule as registration), then copies the dereferenced
content as a regular file. This lets the common `CLAUDE.md → AGENTS.md`
convention materialize cleanly. A symlink whose target escapes the source root,
or one that is dangling/unresolvable, is rejected with `400` so no external
content can be smuggled into the gateway-owned artifact; symlink cycles
terminate via a visited-set guard rather than looping.
