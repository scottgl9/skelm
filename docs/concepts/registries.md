# Registries

The gateway holds four registries that together describe everything it can run, supervise, or invoke. They are populated at `Gateway.start()` from `skelm.config.ts` plus the project's filesystem, and refreshed on `Gateway.reload()` (or `SIGHUP`).

| Registry | Source | Watched? | Notes |
|----------|--------|----------|-------|
| `workflows` | FS scan of `registries.workflows.glob` | yes | Tracks `*.workflow.{mts,ts}` paths; modules import lazily on first use. |
| `workflowPackages` | Explicit installed package roots | reload-only | Tracks package metadata declared in `package.json#skelm.workflowPackage`; no broad `node_modules` scan. |
| `skills` | FS scan of `registries.skills.glob` | yes | Parses `SKILL.md` frontmatter into `Skill` objects. Malformed files are skipped (visible via `getErrors()`). |
| `agents` | `registries.agents` in config | reload-only | Coding agents and ACP agents. Each entry declares `lifecycle: 'resident' \| 'ephemeral'` (see `docs/concepts/coding-agents.md`). |
| `mcpServers` | `registries.mcpServers` in config | reload-only | Static MCP server declarations consumed by the MCP supervisor (Phase 7). |

Every registry exposes the same shape:

```ts
interface Registry<T> {
  list(): T[]
  get(id: string): T | undefined
  on(event: 'change', listener: (change: { added: T[]; removed: T[]; modified: T[] }) => void): () => void
  refresh(): Promise<RegistryChange<T>>
  close(): Promise<void>
}
```

## Default globs

```ts
{
  registries: {
    workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' },
    skills:    { glob: 'skills/**/SKILL.md' },
    agents:    [],
    mcpServers: [],
  },
}
```

Override per project in `skelm.config.ts`.

## Installable workflow packages

Installable workflow packages are ordinary npm dependencies with package
metadata under `skelm.workflowPackage`. Hosts pass explicit installed package
roots to `discoverWorkflowPackage()` / `discoverWorkflowPackages()`, then call
`WorkflowRegistry.registerPackage()` for each discovered package. The registry
stores package metadata and stable package-relative workflow paths; workflow
modules still load lazily through the existing workflow execution path.

See [Workflow Packages](../guides/workflow-packages.md) for the package format
and authoring guidance.

## SKILL.md format

```markdown
---
id: write-tests
description: Write unit tests for the changed code
allowedWorkflows: [build-pr]
---

You are a careful test author. Write tests for the changed code in the
diff. Cover both the happy path and the explicit error cases.
```

Frontmatter is parsed as YAML. Unknown keys flow through to `metadata` for forward-compatible additions.

## Invoking another pipeline (`invoke()`)

A workflow can call any registered pipeline by id from inside its own steps using `invoke()`:

```ts
import { invoke, pipeline } from 'skelm'

export default pipeline({
  id: 'parent',
  steps: [
    invoke<{ result: string }>({
      id: 'delegate',
      pipelineId: 'child-pipeline',          // matches pipeline({ id: 'child-pipeline' })
      input: (ctx) => ({ from: ctx.run.runId }),
    }),
  ],
})
```

The runner resolves `pipelineId` through a `pipelineRegistry` callback:

- **In-process** (`runPipeline(..., { pipelineRegistry })`) — you supply the callback; the unit tests in `packages/core/test/invoke.test.ts` show the shape.
- **Gateway-hosted** — the gateway wires `pipelineRegistry` automatically from its workflows registry. The lookup tries the registry id (the file path, e.g. `fixtures/child.workflow.mts`) first, then falls back to scanning all registered workflows and matching on `pipeline.id` so callers can pass either form. Missing pipelines raise `InvokePipelineNotFoundError`.

The full parent runtime (store, stateStore, permissions, secret resolver, audit writer, egress proxy, `pipelineRegistry` itself) is forwarded to the child run so nested invocations behave identically to top-level ones.

## FS watching

Workflow and skill registries use Node's built-in `fs.watch` with the `recursive` option (Linux 6.5+, macOS, Windows). Older Linux falls back to a single-level watch; the gateway still detects changes via `reload()` / `SIGHUP`. Change events are debounced (default 100 ms).

## Status

Phase 3 of the gateway-centric refactor. Registries land before any code starts consuming them so subsequent phases (audit, MCP supervisor, coding-agent supervisor, scheduler) can attach to a stable surface.
