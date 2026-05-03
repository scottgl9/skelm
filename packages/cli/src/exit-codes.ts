/**
 * Process exit codes for the skelm CLI. Stable; documented in the public
 * docs. Tests assert against these.
 */
export const EXIT = {
  OK: 0,
  CLI_ERROR: 1,
  SCHEMA_VALIDATION: 2,
  RUN_FAILED: 3,
  CANCELLED: 4,
  WAIT_TIMEOUT: 5,
  PERMISSION_DENIED: 6,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
