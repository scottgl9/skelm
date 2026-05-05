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

```ts
import { agent, pipeline } from 'skelm'
import { createOpencodeBackend } from '@skelm/opencode'

const opencode = createOpencodeBackend({
  serverUrl: 'http://127.0.0.1:4096',
  // model, system prompt, tool allowlist, etc.
})

export default pipeline({
  id: 'fix-bug',
  steps: [
    agent({
      id: 'patch',
      backend: opencode,
      agentDef: './agents/coder',
      permissions: {
        allowedTools:    ['edit', 'bash'],
        fsRead:          ['./src'],
        fsWrite:         ['./src'],
        execAllowlist:   ['npm', 'pnpm', 'tsc'],
        networkEgress:   { allowHosts: ['registry.npmjs.org'] },
      },
      maxTurns: 12,
    }),
  ],
})
```

For the gateway-managed flavor that supervises a long-running Opencode server, use `createOpencodeBackendFromConfig` and let `@skelm/gateway` own the lifecycle.

## What's exported

```ts
export { createOpencodeBackend, createOpencodeAcpBackend } from './backend.js'
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
