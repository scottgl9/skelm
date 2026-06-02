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
  STEP_TIMEOUT: 7,
  /**
   * The run finished in the `paused` state — typically because a `wait()`
   * step is awaiting external input. Operators can resume via
   * `POST /runs/:runId/resume` on the gateway. Interactive resume from
   * the CLI is on the follow-up roadmap (needs live SSE event consumption).
   */
  RUN_PAUSED: 8,
  /**
   * The run failed because the selected backend does not support an
   * operation a step required (vision, agentmemory, tool calls, etc.).
   * Distinct from a generic RUN_FAILED so CI / scripts can detect a
   * configuration-class problem without parsing the error message.
   */
  BACKEND_CAPABILITY: 9,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
