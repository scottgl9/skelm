# Workflow Builder

`@skelm/workflow-builder` is a **persistent-agent workflow package** that helps
you create and revise skelm workflows. It ships a `skelm.package.json` manifest
and a persistent-workflow entrypoint: each conversational turn, an agent
inspects the project's existing workflows, proposes a new workflow or
graph/source edits, runs `skelm validate` on the result, and reports a
**reviewable patch** — it never applies a change destructively.

It builds on three existing substrates: the
[persistent workflow](/concepts/persistent-workflows) model (a durable
conversation per session), the [WorkflowGraph](/reference/workflow-graph)
derivation + round-trip apply route (the only write path), and the
[workflow-package](/reference/workflow-packages) manifest format.

## What it does

Per turn, the builder agent runs this loop:

1. **Inspect.** Read the project's `*.workflow.{ts,mts}` files and derive each
   one's read-only [`WorkflowGraph`](/reference/workflow-graph) — never
   serializing author code or secrets.
2. **Propose.** For a *new* workflow, author one minimal, runnable file. For a
   *revision*, prefer declarative graph edits (`reorderSteps`, `setStepField`,
   `addStep`, `removeStep`).
3. **Validate.** Run `skelm validate` against the candidate and fix on error.
4. **Report a reviewable patch.** Surface a unified diff and the file path. A
   change is never implied to be written unless the apply route reported
   `applied: true`.

## The reviewable-patch model

Edits flow through the gateway's round-trip apply route
(`POST /v1/workflows/:id/source/apply`), which is **dry-run by default** and
**`codeOwned`-preserving**:

- A proposal that does not explicitly set `dryRun: false` **never writes** — it
  returns `{ ok: true, applied: false, dryRun: true, diff }` for review.
- Code-owned regions (inline `run` / `while` / `on` / `items` predicates) come
  back as a **refusal** (`reason: 'code-owned'`) rather than a rewrite; those
  require manual TypeScript edits, which the builder surfaces as suggestions.
- The authored TypeScript stays the single source of truth; the graph is always
  re-derived, never edited in place.

The library models this as a [`ReviewablePatch`](#library-api): `applied` is
`false` for every dry-run, so an operator reviews `diff` before any write.

## Declared, default-deny permissions

The persistent workflow declares a **least-privilege** permission ceiling.
Every dimension defaults to deny; the manifest grants only:

| Dimension            | Grant            | Why |
| -------------------- | ---------------- | --- |
| `fsRead`             | `['./']`         | Read the project's existing workflows. **Project-scoped only.** |
| `executableProfiles` | `['nodeBuild']`  | Run `skelm validate` / fixture tests under an operator-defined profile. |
| `allowedSkills`      | `['skelm']`      | The skelm authoring API reference. |

Notably there is **no `fsWrite`**: the agent never writes workflow source
directly. Every write goes through the audited apply route, which the gateway
owns. `networkEgress`, raw `allowedExecutables`, and every other dimension stay
undefined — i.e. denied. The `ProjectSource` read path enforces the project
scope structurally: a read of any path that resolves outside the project root
(absolute escape, `..` traversal, or symlink) throws and never returns bytes.

## Library API

The package also exports the building blocks, so you can embed the build/revise
flow or test it with a stubbed backend (no real LLM, no live gateway):

- `WorkflowBuilder` — `inspect()`, `graphOf()`, `proposeEdits()` (dry-run
  default), `validateWorkflow()`, `turn()`, `generateManifest()`.
- `createProjectSource(root)` / `assertInsideProject(root, path)` — the
  project-scoped, escape-refusing read surface.
- `createGatewayApplyRoute(opts)` / `createGatewayValidateRunner(opts)` — the
  gateway-backed `ApplyRoute` and `ValidateRunner` used at runtime.

```ts
import { WorkflowBuilder, createProjectSource, createGatewayApplyRoute } from '@skelm/workflow-builder'

const builder = new WorkflowBuilder({
  project: createProjectSource(projectRoot),
  applyRoute: createGatewayApplyRoute({ baseUrl, token }),
  validate,
  agent,
})

const inventory = await builder.inspect(loadWorkflow)
const patch = await builder.proposeEdits('greet', edits) // dry-run by default
// patch.applied === false, patch.diff is the preview
```

## Self-test

The package ships a `selfTest` entry that runs the whole build/revise loop
end-to-end against a tiny fixture project with a **stubbed** agent backend — no
real LLM, no live gateway — proving inspect → turn → propose (reviewable) →
validate → manifest. It exits non-zero on any failure.

## Install and run

`@skelm/workflow-builder` is a workflow package; install and run it like any
other (see [Workflow Packages](/reference/workflow-packages)):

```
skelm package install <path-to-@skelm/workflow-builder>
skelm run @skelm/workflow-builder
```

Its `workflow-builder` trigger is, like every package trigger, **disabled until
an operator enables it**.
