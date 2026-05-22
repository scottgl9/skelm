# Recipe — ticket to PR

Watch a ticket queue. For each new ticket of a configured type, check out the relevant repo into a per-repo persistent workspace, attempt the change, open a PR, and update the ticket. Runs continuously on a poll trigger; safe to leave running for weeks.

This recipe exercises:

- Poll-trigger scheduling with dedupe
- `forEach` over fetched tickets with bounded concurrency
- Per-repo persistent workspaces (the workspace name is derived from the item)
- `ctx.state.cas` for durable "already attempted" tracking
- `compensate` callback to clean up partial work on failure
- Decision journals for human review

## Project layout

```
ticket-to-pr/
├── skelm.config.ts
├── workflows/
│   └── ticket-to-pr.workflow.mts
├── agents/
│   └── ticket-coder/
│       ├── AGENTS.md
│       └── SOUL.md
├── skills/
│   └── github-write/SKILL.md
├── sources/
│   └── jira-poll.ts                # named source function
├── secrets/
└── package.json
```

## `sources/jira-poll.ts`

A named source registered in `skelm.config.ts`. Returns new tickets since the last watermark.

```ts
import type { PollSource } from 'skelm'

export const jiraPoll: PollSource<{ id: string; summary: string; description: string; repo: string }> = {
  id: 'jira-tickets',
  fetch: async (ctx) => {
    const since = await ctx.state.get<number>('watermark') ?? 0
    const items = await fetchJiraTicketsSince(since)
    const newWatermark = Math.max(...items.map((t) => t.timestamp), since)
    await ctx.state.set('watermark', newWatermark)
    return { items: items.map(({ id, summary, description, repo }) => ({ id, summary, description, repo })) }
  },
  dedupeKey: (item) => item.id,
}
```

## `skelm.config.ts`

```ts
import { defineConfig } from 'skelm'
import { jiraPoll } from './sources/jira-poll.ts'

export default defineConfig({
  backend: 'copilot-acp',
  backends: {
    'copilot-acp': { command: 'mcp-copilot-acp' },
  },
  defaults: {
    permissions: {
      networkEgress: 'deny',
      allowedExecutables: [],
      allowedTools: [],
      allowedSkills: [],
      allowedMcpServers: [],
      fsRead: [],
      fsWrite: [],
    },
  },
  scheduler: {
    sources: { 'jira-tickets': jiraPoll },
  },
  storage: { workspaces: { base: '~/.skelm/workspaces' } },
  secrets: { driver: 'env' },
})
```

## `workflows/ticket-to-pr.workflow.mts`

```ts
import { pipeline, code, forEach, agent } from 'skelm'
import { z } from 'zod'

const ticket = z.object({
  id: z.string(),
  summary: z.string(),
  description: z.string(),
  repo: z.string(),
})

export default pipeline({
  id: 'ticket-to-pr',
  description: 'For each new Jira ticket, attempt the change and open a PR.',
  input:  z.object({ items: z.array(ticket) }),
  output: z.object({ processed: z.number(), opened: z.array(z.string()) }),
  steps: [
    forEach({
      id: 'process',
      items: (ctx) => ctx.input.items,
      concurrency: 2,
      step: (item) => agent({
        id: 'work',
        backend: 'copilot-acp',
        agentDef: './agents/ticket-coder',
        skills: ['github-write'],
        mcp: [{ id: 'gh', transport: 'stdio', command: 'mcp-github' }],
        workspace: { mode: 'persistent', name: `repo-${item.repo}`, gitRoot: true },
        permissions: {
          allowedTools:       ['gh.create_pr', 'gh.add_comment', 'gh.list_pulls'],
          allowedExecutables: ['git', 'pnpm', 'rg'],
          allowedMcpServers:  ['gh'],
          allowedSkills:      ['github-write'],
          networkEgress:      { allowHosts: ['api.github.com'] },
        },
        prompt: () => `Ticket ${item.id}: ${item.summary}\n\n${item.description}`,
        output: z.object({
          attempted: z.boolean(),
          prUrl:     z.string().optional(),
          reason:    z.string().optional(),
        }),
        maxTurns: 40,
        compensate: async (ctx, output) => {
          // If a later step in the workflow fails after a PR was opened,
          // close the PR with an explanatory comment.
          if (output.prUrl) {
            await ctx.state.append('orphan-prs', { ticketId: item.id, prUrl: output.prUrl, at: Date.now() })
            // The agent's tools include gh.add_comment; closing logic could be a separate code() step.
          }
        },
      }),
    }),
    code({
      id: 'journal',
      run: async (ctx) => {
        const results = ctx.steps.process as Array<{ attempted: boolean; prUrl?: string; reason?: string }>
        for (const r of results) {
          await ctx.state.append('decisions', { at: Date.now(), ...r })
        }
        return {}
      },
    }),
  ],
  finalize: (ctx) => {
    const results = ctx.steps.process as Array<{ attempted: boolean; prUrl?: string }>
    return {
      processed: results.length,
      opened:    results.flatMap((r) => r.prUrl ? [r.prUrl] : []),
    }
  },
})
```

## `agents/ticket-coder/AGENTS.md`

```markdown
---
name: ticket-coder
description: Attempts a code change for a single Jira ticket; opens a PR or explains why not.
version: 1
metadata:
  skelm:
    role: coder
    expectedTurns: long
    requires:
      bins: ['git', 'pnpm', 'rg']
      mcpServers: ['gh']
      skills: ['github-write']
---

# Ticket coder

You attempt one ticket per invocation.

## Method

1. Read the ticket summary and description.
2. `git pull` the workspace.
3. If the ticket is well-defined and the change is bounded (under ~150 lines), make the change on a feature branch and run tests.
4. If tests pass, open a PR with `gh.create_pr` and link the ticket id in the PR body.
5. If the ticket is ambiguous, undersized, or oversized, do not change code; output `{ attempted: false, reason: "<why>" }`.

## Output schema

Always return JSON matching `{ attempted: boolean, prUrl?: string, reason?: string }`.
```

## Schedule it

```sh
skelm schedule add workflows/ticket-to-pr.workflow.mts \
  --poll jira-tickets \
  --id ticket-to-pr \
  --overlap skip

skelm gateway start
```

The poll source runs every 60s by default (configurable in the source); each fire produces a list of new tickets which the workflow's `forEach` handles.

## Why each piece is here

- **Per-item persistent workspace.** Each repo gets its own checkout. Different repos do not collide; the same repo across runs reuses the workspace.
- **`forEach.concurrency: 2`.** Two tickets at a time. Workspace locks prevent two parallel runs from corrupting the same repo's checkout — the framework refuses to start a parallel block where two siblings target the same persistent workspace.
- **`compensate` on the agent step.** If a later step fails after a PR was opened, the orphan PR id is journalled for human cleanup. We deliberately do NOT auto-close PRs from `compensate` — closing PRs is a non-trivial action and the journal lets a human decide.
- **`ctx.state.cas` (recommended).** For tickets that should NEVER be re-attempted (e.g., already-merged), update an `attempted:<id>` key with CAS so concurrent runs cannot re-process. Add this in a `code()` step before the agent if your domain warrants it.

## Inspect what the workflow has done over time

```sh
# All runs in the last week
skelm history --workflow ticket-to-pr --since 7d

# The decision journal
skelm state journal ticket-to-pr decisions --since 7d

# Permission denials (security regressions)
skelm audit query --workflow ticket-to-pr --category permission.denied
```

If a customer asks "what did the workflow do this week," those three commands answer the question without scrolling chat history.
