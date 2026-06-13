/**
 * @skelm/integration-http
 *
 * Generic authenticated HTTP request integration. Build on top of this when
 * you need egress-gated, credential-ref-safe HTTP requests with optional retry,
 * rate limiting, and cursor-based pagination.
 *
 * Credentials are NEVER resolved here — pass gateway-resolved header strings.
 * Authorization header values are redacted from all logged/audited output.
 */

// Actions
export {
  request,
  get,
  post,
  paginateAll,
  auditDescriptor,
  requestActionDef,
  getActionDef,
  postActionDef,
  paginateActionDef,
} from './actions.js'
export type {
  HttpActionOptions,
  RequestInput,
  RequestOutput,
  PaginateInput,
} from './actions.js'

// Errors
export {
  HttpIntegrationError,
  HttpEgressDeniedError,
  HttpClientError,
  HttpServerError,
  HttpNetworkError,
} from './errors.js'

// Health check
export { checkHealth } from './health.js'
export type { HttpHealthCheckOptions } from './health.js'

// Manifest
export { manifest } from './manifest.js'

// Redaction utilities (useful for callers building audit records)
export { redactHeaders, redactUrl } from './redact.js'
