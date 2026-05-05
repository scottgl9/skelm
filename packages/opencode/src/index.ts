/**
 * @skelm/opencode - Opencode.ai backend for skelm
 *
 * Full integration with opencode.ai coding agent via the official SDK,
 * with granular permission enforcement and multi-agent support.
 */

export { createOpencodeBackend, createOpencodeAcpBackend } from './backend.js'
export { createOpencodeBackendFromConfig } from './factory.js'
export type { OpencodeBackendConfig } from './factory.js'
export { OpencodeProvider, createOpencodeProvider } from './provider.js'
export { OpencodeClientWrapper } from './client.js'
export {
  mapSkelmPermissionsToOpencode,
  mapOpencodePermissionsToSkelm,
  validatePermissions,
  buildPermissionAuditEntry,
} from './permission-mapper.js'

export type {
  OpencodeBackendOptions,
  OpencodePermissionConfig,
  MappedPermissions,
} from './types.js'

export type {
  BackendAuthenticationError,
  BackendRateLimitError,
  BackendTimeoutError,
} from './backend.js'
