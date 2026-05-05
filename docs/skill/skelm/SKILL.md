---
name: skelm
description: Author, run, and operate skelm pipelines — typed TypeScript orchestrations for agentic and deterministic workflows with default-deny permissions. Use when the user mentions skelm, agent permissions, pipeline.ts, AgentPermissions, skelm.config.ts, MCP servers, or wants to scaffold a workflow.
license: MIT
compatibility: Requires Node 20+, pnpm or npm, and the `skelm` package installed globally or as a workspace dependency.
metadata:
  homepage: https://github.com/scottgl9/skelm
  version: "0.3.4"
allowed-tools: Read Edit Write Bash(pnpm:*) Bash(skelm:*) Bash(node:*) Bash(git:*)
---

# skelm Skill

## When to activate

Activate when the user is working in a skelm project, wants to author or modify a `*.pipeline.ts` / `*.workflow.ts` file, asks about `AgentPermissions`, `skelm.config.ts`, MCP server wiring, or wants to run, inspect, or operate a pipeline.

---

## The unit of work

A **pipeline** is a TypeScript file that exports a `pipeline()` call. It has:

- `id` — stable string identifier
- `input` / `output` — Zod schemas (validated at run boundaries)
- `steps` — ordered array of `Step` values
- optional `finalize` — transforms the last step's output into the declared output shape

**Step kinds:** `code | llm | agent | parallel | forEach | branch | loop | wait | pipelineStep | idempotent`

Import everything from `'skelm'` (or `'@skelm/core'` in library contexts).

---

## Authoring a pipeline

Minimal example — one deterministic step:

```ts
import { code, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'greet',
  description: 'Greets a user by name.',
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ greeting: z.string() }),
  steps: [
    code({
      id: 'build-greeting',
      run: (ctx) => {
        const { name } = ctx.input as { name: string }
        return { greeting: `Hello, ${name}!` }
      },
    }),
  ],
})
```

Access prior step outputs via `ctx.steps['step-id']`. Access run metadata via `ctx.run.runId`.

For multi-step composition, LLM inference, and control flow, see [references/pipeline-authoring.md](references/pipeline-authoring.md).

---

## Adding an agent step

> **Default-deny:** every `AgentPermissions` field defaults to deny when omitted. An agent with no `permissions` block cannot call tools, read files, execute binaries, attach MCP servers, or make network requests.

Minimal agent step with explicit permissions:

```ts
import { agent, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'ticket-to-pr',
  input: z.object({ ticketId: z.string() }),
  output: z.object({ prUrl: z.string() }),
  steps: [
    agent({
      id: 'implement',
      backend: 'opencode',
      prompt: (ctx) => `Implement ticket ${(ctx.input as { ticketId: string }).ticketId}`,
      permissions: {
        allowedTools: ['gh.*'],          // GitHub CLI tools only
        allowedExecutables: ['git'],
        allowedMcpServers: ['github'],
        fsRead: ['./'],
        fsWrite: ['./src/', '/tmp/'],
        networkEgress: { allowHosts: ['api.github.com'] },
      },
      workspace: { mode: 'ephemeral', cleanup: 'on-run-end' },
    }),
  ],
})
```

For full `agent()` options, workspace modes, MCP wiring, and multi-turn control, see [references/agent-step.md](references/agent-step.md).

---

## Permissions are part of the API

The permission model has **7 dimensions**. All default to deny.

| Dimension | Field | Description |
|---|---|---|
| Tool | `allowedTools` / `deniedTools` | Tool IDs the agent may call; prefix `gh.*` or `*` wildcard |
| Executable | `allowedExecutables` | Binaries allowed for any exec/bash tool |
| MCP server | `allowedMcpServers` | IDs from `skelm.config.ts` the agent may attach |
| Skill | `allowedSkills` | Skill IDs the agent may load |
| Network | `networkEgress` | `'allow'` \| `'deny'` \| `{ allowHosts: [...] }` |
| FS read | `fsRead` | Path roots the agent may read |
| FS write | `fsWrite` | Path roots the agent may write |

**Composition is intersection-only.** Project defaults → permission profile → step-level permissions. Each layer can only narrow, never widen. If a project default denies network and a step sets `networkEgress: 'allow'`, the resolved policy is still deny.

Named profiles in `skelm.config.ts`:

```ts
defaults: {
  permissionProfiles: {
    'read-only': { fsRead: ['./'], networkEgress: 'deny' },
    'full-write': { fsRead: ['./'], fsWrite: ['./'], networkEgress: 'allow' },
  },
}
```

Apply a profile in a step: `permissions: { profile: 'read-only', allowedTools: ['rg'] }` — tools are still intersected with the profile.

See [references/permissions.md](references/permissions.md) for the full enforcement model.

---

## Project layout

```
my-project/
├── skelm.config.ts          # Required for gateway and agent steps
├── hello.pipeline.ts        # One pipeline per file; name matches pipeline id
├── ticket-to-pr.pipeline.ts
└── package.json             # { "dependencies": { "skelm": "^0.3.0", "zod": "^3" } }
```

Pipeline files may also be named `*.workflow.ts` — the two extensions are treated identically.

For `skelm.config.ts` shape and all config options, see [references/config.md](references/config.md).

---

## Running and inspecting

```bash
# Run once, pass input as JSON
skelm run ./ticket-to-pr.pipeline.ts --input '{"ticketId":"PROJ-42"}'

# Run with input from file
skelm run ./ticket-to-pr.pipeline.ts --input-file input.json

# List discovered pipelines
skelm list

# Describe a pipeline (human-readable or mermaid diagram)
skelm describe ticket-to-pr
skelm describe ticket-to-pr --format mermaid

# View run history
skelm history --last 10 --json
```

Full CLI reference at [references/cli.md](references/cli.md). Exit codes: `0` ok, `1` CLI error, `2` schema validation, `3` run failed, `4` cancelled, `5` wait timeout, `6` permission denied.

---

## The gateway is the trust boundary

The gateway owns all security-critical infrastructure: permission resolution, secret resolution, audit log, approval gating. **Never write permission enforcement in pipeline or step code** — call gateway helpers or use `TrustEnforcer` from `@skelm/core` only in tests and demos.

```bash
skelm gateway start            # starts in background, writes pid file
skelm gateway status           # shows pid / url / state
skelm gateway stop
```

Agent steps are enforced by the gateway at dispatch time. A step that declares `allowedMcpServers: ['github']` cannot attach any other server, regardless of what the backend requests. See [references/gateway.md](references/gateway.md).

---

## Tests are not optional

Every behavior change ships with tests. For permission paths:

- **Default-deny fixture** — prove the action is denied when the permission field is omitted.
- **Explicit-deny fixture** — prove the action is denied when the field is present but excludes the target.
- Both fixtures are required, not one or the other.

```bash
pnpm check   # build → typecheck → lint → unit → guards → adversarial → contract → doc-links
```

Never claim a task done until `pnpm check` is green.

---

## Common pitfalls

- **Widening at step level** — setting `networkEgress: 'allow'` in a step when the project default is `deny` has no effect. Intersection always wins.
- **Missing Zod schema** — `input` / `output` are validated at run boundaries; omitting them skips validation silently.
- **`agent()` without a declared backend** — the step fails at runtime if `backend` is set but not declared in `skelm.config.ts` under `registries.agents`.
- **Editing `dist/`** — generated files; never edit. Run `pnpm build` to regenerate.
- **Step id collisions** — step ids must be unique within a `parallel()` block; the runtime tracks uniqueness globally per run.

---

## Scaffold a new pipeline

```bash
bash docs/skill/skelm/scripts/new-pipeline.sh my-pipeline "What this pipeline does"
```

This copies `assets/pipeline.template.ts` to `./my-pipeline.pipeline.ts` and substitutes the id and description. Use `assets/agent-pipeline.template.ts` for pipelines that include an agent step.
