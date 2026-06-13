# @skelm/workflow-builder

A **persistent-agent workflow package** for [skelm](https://skelm.dev) that
helps you create and revise skelm workflows. It ships a `skelm.package.json`
manifest plus a persistent-workflow entrypoint: each conversational turn, an
agent inspects the project's existing workflows, proposes a new workflow or
graph/source edits, runs `skelm validate`, and reports a **reviewable patch** —
it never applies a change destructively.

See the full reference at
[docs → Workflow Builder](https://skelm.dev/reference/workflow-builder).

## The loop

1. **Inspect** — read the project's `*.workflow.{ts,mts}` files and derive each
   one's read-only `WorkflowGraph` (never serializing author code or secrets).
2. **Propose** — author a new workflow file, or revise via declarative graph
   edits (`reorderSteps`, `setStepField`, `addStep`, `removeStep`).
3. **Validate** — run `skelm validate` on the candidate; fix on error.
4. **Report a reviewable patch** — a unified diff and the file path. Nothing is
   implied written unless the apply route reported `applied: true`.

## Reviewable patches, never destructive writes

Edits flow through the gateway's round-trip apply route
(`POST /v1/workflows/:id/source/apply`), which is **dry-run by default** and
**`codeOwned`-preserving**:

- A proposal that does not explicitly set `dryRun: false` never writes; it
  returns a diff for review.
- Code-owned regions (inline `run` / `while` / `on` / `items` predicates) are
  **refused**, not rewritten — they need manual TypeScript edits.

## Permissions — declared and default-deny

The persistent workflow declares a least-privilege ceiling. Every dimension
defaults to deny; only these are granted:

- `fsRead: ['./']` — read the project's workflows, **project-scoped**.
- `executableProfiles: ['nodeBuild']` — run `skelm validate` / tests under an
  operator-defined profile.
- `allowedSkills: ['skelm']` — the authoring API reference.

There is **no `fsWrite`**: the agent never writes source directly. Every write
goes through the audited apply route. The `ProjectSource` read path refuses any
path that resolves outside the project root (absolute, `..`, or symlink).

## Library API

```ts
import {
  WorkflowBuilder,
  createProjectSource,
  createGatewayApplyRoute,
  createGatewayValidateRunner,
} from '@skelm/workflow-builder'

const builder = new WorkflowBuilder({
  project: createProjectSource(projectRoot),
  applyRoute: createGatewayApplyRoute({ baseUrl, token }),
  validate: createGatewayValidateRunner({ baseUrl, token }),
  agent, // any SkelmBackend with run(); stub it in tests
})

const inventory = await builder.inspect(loadWorkflow)
const patch = await builder.proposeEdits('greet', edits) // dry-run by default
```

The `ApplyRoute`, `ValidateRunner`, and `ProjectSource` are all injectable, so
the build/revise flow is fully testable with a stubbed agent backend — no real
LLM and no live gateway.

## Install and run

```
skelm package install <path-to-package>
skelm run @skelm/workflow-builder
```

The package's trigger is disabled until an operator enables it.

## License

MIT
