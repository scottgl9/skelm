# @skelm/agentmemory

First-class [agentmemory](https://github.com/rohitg00/agentmemory) integration for skelm.

This package ships a typed REST client and a gateway-wired `AgentmemoryHandle`
implementation. Backends (`@skelm/agent`, `@skelm/codex`, `@skelm/opencode`,
`@skelm/vercel-ai`, `@skelm/pi`) consume the handle through
`BackendContext.agentmemory` to record observations and recall context across
runs.

## Quick start

Run the agentmemory server locally:

```sh
npx @agentmemory/agentmemory
```

Enable the integration in `skelm.config.ts`:

```ts
import { defineConfig } from '@skelm/core'

export default defineConfig({
  agentmemory: {
    enabled: true,
    url: 'http://localhost:3111',
    secretName: 'AGENTMEMORY_SECRET',
    timeoutMs: 3000,
  },
  defaults: {
    permissions: {
      agentmemory: {
        allowObserve: true,
        allowSearch: true,
        allowSession: true,
      },
    },
  },
})
```

Opt in per step:

```ts
agent({
  id: 'review',
  permissions: { agentmemory: { allowObserve: true, allowSearch: true } },
})
```

## Permissions

The dimension is **default-deny**. Omitting `permissions.agentmemory`
denies all four operations (`observe`, `search`, `session`, `context`).
`'deny'` shorthand zeroes the dimension even when defaults granted it.

## Trust boundary

The gateway owns the agentmemory `fetch` and the bearer secret. Runtime
and backends never call the network directly — they invoke methods on the
gateway-provided `AgentmemoryHandle`, which gates each call through
`TrustEnforcer.canUseAgentmemory()` and emits `permission.denied` events
on denial.
