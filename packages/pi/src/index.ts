/**
 * @skelm/pi - Pi coding agent backend for skelm
 * 
 * Integration with the Pi coding agent (https://pi.dev) via subprocess/RPC mode.
 * Permission enforcement at the skelm layer maintains control over execution.
 */

export { createPiBackend } from './backend.js'
export { createPiBackendFromConfig } from './factory.js'
export { PiProvider, createPiProvider } from './provider.js'
export type { PiBackendOptions } from './types.js'
