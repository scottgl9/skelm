# agentmemory example

Cross-session memory for agent steps via the [agentmemory](https://github.com/rohitg00/agentmemory)
microservice. See the [agentmemory guide](../../docs/guides/agentmemory.md) for the full model.

## Setup

1. **Start the memory server:**

   ```sh
   npx @agentmemory/agentmemory
   ```

   It listens on `http://localhost:3111` by default. Check it: `curl http://localhost:3111/agentmemory/health`.

2. **Enable it in your config.** This folder's [`skelm.config.ts`](./skelm.config.ts) turns on the
   integration and grants the `observe` / `search` / `session` ops as project defaults. When the
   gateway starts it logs `agentmemory client wired` (or a warning if the server is unreachable).

## Run the two-run recall pattern

The integration is automatic on supported backends. Run the pipeline twice with related prompts —
the first run records observations; the second recalls them into the model's system prompt as a
`<memory>` block:

```sh
skelm run examples/agentmemory/agentmemory.workflow.mts \
  --input '{"task":"We use HS256 for signing JWTs. Acknowledge."}'

skelm run examples/agentmemory/agentmemory.workflow.mts \
  --input '{"task":"What algorithm do we use to sign JWTs?"}'
```

Each run opens a session, captures the prompt as a `user_prompt_submit` observation, recalls
relevant context, observes tool calls (per tool on `@skelm/agent`, per turn elsewhere), and closes
the session on exit. Watch the gateway run-events stream for `permission.denied` /
`agentmemory.error` events if memory has no effect.

## Beyond the automatic loop

A custom [backend](../../docs/guides/writing-a-backend.md) receives the handle as `ctx.agentmemory`
and can drive memory explicitly. Each op is default-deny, so grant it in the step's permissions
(`allowSave`, `allowRecall`, `allowGraph`):

```ts
const mem = ctx.agentmemory
if (mem !== undefined) {
  await mem.save({ title: 'Auth decision', content: 'We standardized on HS256.' }) // allowSave
  const recent = await mem.recall({ limit: 5 })                                     // allowRecall
  const sessions = await mem.sessions({ limit: 10 })                                // allowRecall
  const graph = await mem.graphQuery({ query: 'authentication' })                   // allowGraph
}
```

Calls never throw into your loop — a denied op returns an empty result and emits `permission.denied`;
a transport failure emits `agentmemory.error`.
