/**
 * Agent-harness validators — pure, caller-supplied checks run by the native
 * `@skelm/agent` loop. Two hooks:
 *
 *   - `toolValidators` run before each tool dispatch (gate side effects).
 *   - `outputValidators` run once on the final assistant text.
 *
 * A validator is a pure (sync or async) function: NO LLM calls inside the
 * harness. A failing soft validator records a `run.warning` and the run
 * continues; a failing hard validator throws `AgentValidationError`. These
 * are harness safety checks, distinct from skelm's core schema validation
 * (the runtime still validates `outputSchema` against the step result) and
 * from the permission policy — validators never widen anything.
 */

/** Outcome of a single validator. `ok: true` passes; `ok: false` fails. */
export type ValidationResult =
  | { ok: true }
  | {
      ok: false
      /** Human-readable reason; surfaced on the warning or the thrown error. */
      reason: string
      /**
       * `'soft'` (default) records a `run.warning` and continues; `'hard'`
       * throws `AgentValidationError` and aborts the run.
       */
      severity?: 'soft' | 'hard'
    }

/** Context handed to an output validator. */
export interface OutputValidatorContext {
  /** Why the loop stopped this turn (e.g. `'stop'`, `'tool_calls'`). */
  readonly stopReason?: string
  /** Parsed structured output when an `outputSchema` was requested. */
  readonly structured?: unknown
}

/** Context handed to a tool validator, before the tool is dispatched. */
export interface ToolValidatorContext {
  /** The tool name the model asked to call. */
  readonly tool: string
  /** Parsed tool arguments (best-effort `JSON.parse` of the call). */
  readonly args: unknown
}

/** Validates the final assistant text once the loop has an answer. */
export type OutputValidator = (
  text: string,
  ctx: OutputValidatorContext,
) => ValidationResult | Promise<ValidationResult>

/** Validates a tool call before it is dispatched. */
export type ToolValidator = (
  ctx: ToolValidatorContext,
) => ValidationResult | Promise<ValidationResult>

/**
 * Thrown when a hard validator fails (`severity: 'hard'`). Carries which
 * stage failed and the validator's reason. A `run.warning`
 * (code `agent.validator.<stage>`) is emitted before this throws, so the
 * abort is observable in the event log.
 */
export class AgentValidationError extends Error {
  override readonly name = 'AgentValidationError'
  constructor(
    readonly stage: 'output' | 'tool',
    readonly reason: string,
    readonly backendId?: string,
  ) {
    super(
      `agent ${stage} validation failed: ${reason}${
        backendId !== undefined ? ` [${backendId}]` : ''
      }`,
    )
  }
}
