# @skelm/opencode

> [Opencode.ai](https://opencode.ai) coding-agent backend for [skelm](https://github.com/scottgl9/skelm) — full granular permission enforcement, multi-agent support.

[![npm](https://img.shields.io/npm/v/@skelm/opencode)](https://www.npmjs.com/package/@skelm/opencode)

Part of [skelm](https://github.com/scottgl9/skelm).

Drives Opencode through its official SDK, mapping skelm's `AgentPermissions` model onto Opencode's permission primitives so a denied tool, exec, host, or filesystem write fails at step start instead of leaking past the trust boundary.

## Install

```bash
npm install @skelm/opencode
```

You also need an Opencode runtime — the package speaks to a running Opencode server / SDK process; it does not vendor the agent.

## Quick Start

Register the backend in `skelm.config.ts`:

```ts
// skelm.config.ts
import { defineConfig } from 'skelm'
import { createOpencodeBackendFromConfig } from '@skelm/opencode'

export default defineConfig({
  backends: { agent: 'opencode' },
  instances: [
    createOpencodeBackendFromConfig({
      id: 'opencode',
      agent: 'build',                     // 'build', 'plan', or a custom opencode agent id
      apiKey: { secret: 'OPENCODE_API_KEY' },
    }),
  ],
})
```

A workflow that applies a fix to a codebase:

```ts
// workflows/fix-bug.workflow.mts
import { agent, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'fix-bug',
  input:  z.object({ description: z.string() }),
  output: z.object({ summary: z.string() }),
  steps: [
    agent({
      id: 'patch',
      backend: 'opencode',
      prompt: (ctx) => `Fix the following bug and return a JSON summary {summary}:\n${ctx.input.description}`,
      permissions: {
        allowedTools:       [],
        allowedExecutables: ['npm', 'pnpm', 'tsc'],
        allowedMcpServers:  [],
        allowedSkills:      [],
        fsRead:             ['./src'],
        fsWrite:            ['./src'],
        networkEgress:      { allowHosts: ['registry.npmjs.org'] },
      },
      output: z.object({ summary: z.string() }),
      maxTurns: 12,
    }),
  ],
})
```

`createOpencodeBackendFromConfig` lets `@skelm/gateway` supervise the Opencode server lifecycle. For a short-lived instance, use `createOpencodeBackend` and pass your own server URL.

## What's exported

```ts
export { createOpencodeBackend } from './backend.js'
export { createOpencodeBackendFromConfig } from './factory.js'
export { OpencodeProvider, createOpencodeProvider } from './provider.js'
export { OpencodeClientWrapper } from './client.js'
export {
  mapSkelmPermissionsToOpencode,
  mapOpencodePermissionsToSkelm,
  validatePermissions,
  buildPermissionAuditEntry,
} from './permission-mapper.js'

export type {
  OpencodeBackendOptions, OpencodePermissionConfig, MappedPermissions,
  BackendAuthenticationError, BackendRateLimitError, BackendTimeoutError,
} from './types.js'
```

## Permission mapping

Permissions declared on the skelm `agent()` step are translated into Opencode's permission types before each turn. A denial — wrong tool, wrong host, wrong filesystem path, wrong exec — surfaces as a `permission-denied` event on the bus and a non-zero exit code on the run.

See [`docs/backends/opencode.md`](https://github.com/scottgl9/skelm/blob/main/docs/backends/opencode.md) for the full mapping table.

## Stability

`0.x` — APIs may change between minor versions until v1.

## License

[MIT](LICENSE)
