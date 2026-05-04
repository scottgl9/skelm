# Registries

The gateway holds four registries that together describe everything it can run, supervise, or invoke. They are populated at `Gateway.start()` from `skelm.config.ts` plus the project's filesystem, and refreshed on `Gateway.reload()` (or `SIGHUP`).

| Registry | Source | Watched? | Notes |
|----------|--------|----------|-------|
| `workflows` | FS scan of `registries.workflows.glob` | yes | Tracks `*.workflow.ts` paths; modules import lazily on first use. |
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
    workflows: { glob: 'workflows/**/*.workflow.ts' },
    skills:    { glob: 'skills/**/SKILL.md' },
    agents:    [],
    mcpServers: [],
  },
}
```

Override per project in `skelm.config.ts`.

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

Frontmatter is a small subset of YAML: `key: value` and `key: [a, b]`. Quoted strings are supported. Unknown keys flow through to `metadata` for forward-compatible additions.

## FS watching

Workflow and skill registries use Node's built-in `fs.watch` with the `recursive` option (Linux 6.5+, macOS, Windows). Older Linux falls back to a single-level watch; the gateway still detects changes via `reload()` / `SIGHUP`. Change events are debounced (default 100 ms).

## Status

Phase 3 of the gateway-centric refactor. Registries land before any code starts consuming them so subsequent phases (audit, MCP supervisor, coding-agent supervisor, scheduler) can attach to a stable surface.
