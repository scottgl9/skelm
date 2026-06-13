/**
 * Typed errors for the Postgres workflow integration. Never throw bare strings;
 * never place a connection string or parameter value into an error message.
 */

/** Base error for the Postgres integration. */
export class PostgresIntegrationError extends Error {
  override readonly name: string = 'PostgresIntegrationError'
}

/**
 * A statement or parameter set violated the parameterized-only contract — e.g.
 * an empty statement, or params supplied as something other than an array.
 * SQL-injection safety in this package is structural: the action API only ever
 * binds `params` positionally and never interpolates them into `text`.
 */
export class PostgresValidationError extends PostgresIntegrationError {
  override readonly name: string = 'PostgresValidationError'
}

/** A connection could not be built from the supplied credential references. */
export class PostgresConnectionError extends PostgresIntegrationError {
  override readonly name: string = 'PostgresConnectionError'
}

/** The database rejected a statement at execution time. */
export class PostgresQueryError extends PostgresIntegrationError {
  override readonly name: string = 'PostgresQueryError'
}
