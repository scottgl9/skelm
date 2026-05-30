/**
 * Identifier/payload primitives used across the codebase. Carved into a
 * leaf module so `run-store.ts`, `events.ts`, and `errors.ts` can
 * depend on them without dragging in `types.ts` — whose richer shapes
 * inline-import back into `run-store`, `permissions`, and `backend`,
 * closing import cycles that madge would otherwise flag.
 *
 * `types.ts` re-exports everything here so existing consumers
 * (`import { RunId } from '@skelm/core'`) keep working unchanged.
 */

/** Stable run identifier. UUID v4 in practice; opaque string in the type. */
export type RunId = string

/** Stable identifier for a step within a pipeline. */
export type StepId = string

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting'

export type StepStatus = 'completed' | 'failed' | 'skipped' | 'waiting'

/** Discriminator for step kinds; the union grows in later stages. */
export type StepKind =
  | 'code'
  | 'infer'
  | 'agent'
  | 'idempotent'
  | 'parallel'
  | 'forEach'
  | 'branch'
  | 'loop'
  | 'wait'
  | 'pipelineStep'
  | 'invoke'

/** A serialized error suitable for storage and event payloads. */
export interface SerializedError {
  readonly name: string
  readonly message: string
  readonly stack?: string
}
