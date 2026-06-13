/**
 * @skelm/integration-postgres
 *
 * A workflow Postgres integration for skelm: parameterized `query`, `execute`,
 * and `transaction` actions plus a polling trigger, built on the
 * `@skelm/integration-sdk` primitives.
 *
 * This is a WORKFLOW integration for user data operations. It is unrelated to
 * core's `PostgresRunStore` (which persists run state); it reuses the same `pg`
 * driver and Pool pattern but operates on the operator's own database via
 * gateway-resolved credential references.
 *
 * SECURITY: credentials are references only; the pg Pool is built at dispatch
 * from gateway-resolved values and never persisted. The action API is
 * parameterized-only (`{ text, params }`) — params are bound, never
 * interpolated — so SQL injection through a parameter value is inert by
 * construction.
 */

// Errors
export {
  PostgresConnectionError,
  PostgresIntegrationError,
  PostgresQueryError,
  PostgresValidationError,
} from './errors.js'

// Types
export type {
  ExecutorProvider,
  PostgresConnection,
  PostgresConnectionInput,
  PostgresResult,
  PostgresRow,
  PostgresStatement,
  QueryExecutor,
  ResolvedPostgresConnection,
} from './types.js'

// Connection model + Pool-at-dispatch executor
export {
  POSTGRES_CREDENTIAL_SCHEMA_ID,
  definePostgresConnection,
  poolExecutorProvider,
} from './connection.js'
export type { PostgresCredentialField } from './connection.js'

// Actions
export { execute, query, transaction, validateStatement } from './actions.js'
export type { PostgresAuditRecord } from './actions.js'

// Audit redaction
export { POSTGRES_AUDIT_REDACTION, redactStatement } from './redaction.js'

// Health
export { checkHealth } from './health.js'

// Polling trigger
export { pollOnce } from './trigger.js'
export type { PollCursor, PollResult, PollTriggerConfig } from './trigger.js'

// Manifest
export {
  POSTGRES_CREDENTIAL_SCHEMA,
  POSTGRES_LIVE_TEST,
  postgresManifest,
} from './manifest.js'
