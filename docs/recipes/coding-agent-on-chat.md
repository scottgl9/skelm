# Recipe — coding agent on chat

A long-running coding workflow reachable via webhook (Telegram, Slack, generic HTTP). It receives a message, decides whether it is a coding request, makes the change in a persistent repo workspace, opens a PR, and replies.

This recipe exercises:

- Webhook-triggered scheduling
- A persistent agent workspace with `gitRoot: true`
- Agent definition in `AGENTS.md` + `SOUL.md`
- Skill-packaged GitHub access
- `ctx.state` for idempotency on inbound messages
- Default-deny permissions narrowed to exactly what the agent needs

## Project layout

```
coding-agent-on-chat/
├── skelm.config.ts
├── workflows/
│   └── coding.workflow.ts
├── agents/
│   └── coder/
│       ├── AGENTS.md
│       └── SOUL.md
├── skills/
│   ├── github-write/SKILL.md
│   └── chat-reply/SKILL.md
├── secrets/
│   └── default.json          # gitignored
├── package.json
└── tsconfig.json
```

## `skelm.config.ts`

```ts
import { defineConfig } from 'skelm'

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
  storage: {
    workspaces: { base: '~/.skelm/workspaces' },
  },
  secrets: { driver: 'env' },
  server: { port: 14738, host: '127.0.0.1', auth: { mode: 'none' } },
})
```

## `agents/coder/AGENTS.md`

```markdown
---
name: coder
description: Reads a chat message; if it asks for a code change, makes the change in a checked-out repo, opens a PR, and replies.
version: 1
metadata:
  skelm:
    role: coder
    expectedTurns: long
    requires:
      bins: ['git', 'pnpm', 'rg']
      mcpServers: ['gh', 'chat']
      skills: ['github-write', 'chat-reply']
    grants:
      tools: ['gh.create_pr', 'gh.add_comment', 'chat.send_message']
---

# Coder

You are a careful coder. Given a chat message and a checked-out repository, you make minimal targeted changes.

## Method

1. Read the message. Decide whether it is a coding request, a question, or chat.
2. If it is a coding request:
   a. `git pull` the workspace.
   b. Identify the smallest change that addresses the request.
   c. Make the change. Run `pnpm test` if a test suite exists.
   d. Commit on a feature branch.
   e. Open a PR via `gh.create_pr`.
   f. Reply with a link to the PR via `chat.send_message`.
3. If it is a question, answer it concisely; do not modify code.
4. If it is chat, reply briefly and stop.

## Boundaries

- Never modify CI configuration unless the request is explicitly about CI.
- Never delete files unless the request explicitly requests deletion.
- If the change requires more than ~200 lines, ask for confirmation in chat before proceeding.
```

## `agents/coder/SOUL.md`

```markdown
# Soul

You are calm, terse, and conservative. You quote the relevant code lines when explaining a change. You do not add motivational filler.

## Standing reminders

- Prefer the smallest correct change.
- A failing test is a stop sign.
- "I'm not sure" is a complete answer when warranted.
```

## `skills/github-write/SKILL.md`

```markdown
---
name: github-write
description: Provides write access to GitHub via the `gh` MCP server.
version: 1
metadata:
  skelm:
    requires:
      mcpServers: ['gh']
    grants:
      tools: ['gh.create_pr', 'gh.add_comment', 'gh.list_pulls']
---

# GitHub write capability

Tools available:

- `gh.create_pr` — open a pull request from a branch.
- `gh.add_comment` — comment on an issue or PR.
- `gh.list_pulls` — list open PRs.
```

## `skills/chat-reply/SKILL.md`

```markdown
---
name: chat-reply
description: Sends replies to the originating chat channel.
version: 1
metadata:
  skelm:
    requires:
      mcpServers: ['chat']
    grants:
      tools: ['chat.send_message']
---

# Chat reply capability

Use `chat.send_message` to reply to the chat that triggered this workflow.
```

## `workflows/coding.workflow.ts`

```ts
import { pipeline, code, agent } from 'skelm'
import { z } from 'zod'

const inboundMessage = z.object({
  messageId: z.string(),
  channel: z.string(),
  sender: z.string(),
  text: z.string(),
})

export default pipeline({
  id: 'coding-on-chat',
  description: 'Coding agent reachable via webhook.',
  input:  inboundMessage,
  output: z.object({
    handled: z.boolean(),
    prUrl: z.string().optional(),
    reply: z.string().optional(),
  }),
  steps: [
    code({
      id: 'idempotency-check',
      run: async (ctx) => {
        const seen = await ctx.state.get<boolean>(`msg:${ctx.input.messageId}`)
        return { alreadySeen: !!seen }
      },
    }),
    code({
      id: 'mark-seen',
      run: async (ctx) => {
        if (!ctx.steps['idempotency-check'].alreadySeen) {
          await ctx.state.set(`msg:${ctx.input.messageId}`, true, { ttlMs: 1000 * 60 * 60 * 24 * 30 })
        }
        return {}
      },
    }),
    agent({
      id: 'work',
      backend: 'copilot-acp',
      agentDef: './agents/coder',
      skills: ['github-write', 'chat-reply'],
      mcp: [
        { id: 'gh',   transport: 'stdio', command: 'mcp-github' },
        { id: 'chat', transport: 'stdio', command: 'mcp-chat-bridge' },
      ],
      workspace: { mode: 'persistent', name: 'main', gitRoot: true },
      permissions: {
        allowedTools: [
          'gh.create_pr', 'gh.add_comment', 'gh.list_pulls',
          'chat.send_message',
        ],
        allowedExecutables: ['git', 'pnpm', 'rg'],
        allowedMcpServers:  ['gh', 'chat'],
        allowedSkills:      ['github-write', 'chat-reply'],
        networkEgress:      { allowHosts: ['api.github.com', 'chat.bridge.local'] },
        // fsRead / fsWrite default to the workspace root via the intersection rule.
      },
      prompt: (ctx) => `New chat message from ${ctx.input.sender} in ${ctx.input.channel}:\n\n${ctx.input.text}`,
      output: z.object({
        handled:  z.boolean(),
        prUrl:    z.string().optional(),
        reply:    z.string().optional(),
      }),
      maxTurns: 30,
    }),
    code({
      id: 'journal',
      run: async (ctx) => {
        await ctx.state.append('decisions', {
          at: Date.now(),
          messageId: ctx.input.messageId,
          handled: ctx.steps.work.handled,
          prUrl: ctx.steps.work.prUrl,
        })
        return {}
      },
    }),
  ],
  finalize: (ctx) => ({
    handled: ctx.steps.work.handled,
    prUrl:   ctx.steps.work.prUrl,
    reply:   ctx.steps.work.reply,
  }),
})
```

## Schedule it

```sh
# Register a webhook schedule
skelm schedule add workflows/coding.workflow.ts \
  --webhook /webhooks/chat \
  --id coding-chat-bridge \
  --overlap skip

# Start the gateway
skelm gateway start
```

External chat-bridge service POSTs to `http://gateway-host:14738/webhooks/chat` with the inbound message body matching the `input` schema. Each POST fires one run.

## Why each piece is here

- **Persistent workspace + `gitRoot: true`** — the agent keeps a checked-out copy of the repo across runs. Git history doubles as a transcript of what the agent has changed over time.
- **Idempotency check + journal** — repeated webhook fires of the same `messageId` are no-ops at the agent layer; decisions are journalled for review.
- **`overlap: skip`** — if the previous run is still in flight when a new message arrives, skip. Prevents workspace lock thrash.
- **Narrow `permissions`** — agent can only call the listed tools, run the listed binaries, and reach the listed hosts. The workspace intersection means it can read/write only inside the checkout.
- **Skill packages** — `github-write` and `chat-reply` are reusable across multiple coding workflows. The role agent definition references both.

## Inspecting what the agent did

```sh
skelm history --workflow coding-on-chat --since 7d
skelm history --run <runId> --events
skelm audit query --workflow coding-on-chat --category permission.denied --since 7d
```

The audit log shows every permission denial; if the agent kept trying to do something it cannot, you will see it here. Add the tool to `allowedTools` only if the action is truly intended.
