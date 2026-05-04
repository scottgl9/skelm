/**
 * @skelm/pi - Pi coding agent backend for skelm
 *
 * Integration with the Pi coding agent (@mariozechner/pi-coding-agent) via
 * RPC mode. Spawns `pi --mode rpc` per call, uses the documented JSONL
 * protocol to stream the response.
 */

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
