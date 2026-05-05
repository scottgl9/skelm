# @skelm/pi

> Pi coding-agent backend for [skelm](https://github.com/scottgl9/skelm) — drives [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) over its JSONL RPC protocol with full permission enforcement.

[![npm](https://img.shields.io/npm/v/@skelm/pi)](https://www.npmjs.com/package/@skelm/pi)

Part of [skelm](https://github.com/scottgl9/skelm).

Spawns `pi --mode rpc` per call and streams the response back over the documented JSONL protocol. Maps skelm's `AgentPermissions` onto Pi's permission flags so denied tools / hosts / filesystem writes fail at step start.

## Install

```bash
npm install @skelm/pi
```

You need the `pi` CLI on `$PATH` (or set `command` in the backend options).

## Quick Start

```ts
import { agent, pipeline } from 'skelm'
import { createPiBackend } from '@skelm/pi'

const pi = createPiBackend({
  command: 'pi',
  model: 'qwen-3-coder-32b',
  // ...
})

export default pipeline({
  id: 'refactor',
  steps: [
    agent({
      id: 'pi-step',
      backend: pi,
      agentDef: './agents/coder',
      permissions: {
        allowedTools: ['edit', 'bash'],
        fsRead:       ['./src'],
        fsWrite:      ['./src'],
      },
      maxTurns: 8,
    }),
  ],
})
```

## What's exported

```ts
export {
  createPiBackend,
  PiBackendError,
  PiBackendAuthenticationError,
  PiBackendRateLimitError,
  PiBackendTimeoutError,
} from './backend.js'
export { createPiBackendFromConfig } from './factory.js'
export { PiProvider, createPiProvider } from './provider.js'
export { PiRpcClient } from './rpc-client.js'

export type { PiBackendOptions } from './types.js'
export type { PiBackendConfig } from './factory.js'
export type { PiRpcClientOptions, PiRpcResponse } from './rpc-client.js'
```

## Stability

`0.x` — APIs may change between minor versions until v1.

## License

[MIT](LICENSE)
