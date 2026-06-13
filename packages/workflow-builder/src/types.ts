// Public types for @skelm/workflow-builder. The builder inspects a project's
// existing workflows, proposes new workflows or graph/source edits, and runs
// `skelm validate` — always producing REVIEWABLE patches rather than
// auto-applying. Writes flow exclusively through the gateway's round-trip
// apply route (dry-run-default, codeOwned-preserving).

import type { GraphEdit, GraphEditFailureReason, WorkflowGraph } from '@skelm/core'

/** A workflow discovered in the target project, with its derived graph. */
export interface InspectedWorkflow {
  /** Workflow id (graph id). */
  readonly id: string
  /** Absolute path to the workflow source file. */
  readonly path: string
  /** Project-relative path, forward-slash normalized. */
  readonly relativePath: string
  /** TypeScript source of the workflow file. */
  readonly source: string
  /** Read-only AST derived from the workflow; never carries author code or secrets. */
  readonly graph: WorkflowGraph
}

/**
 * A reviewable patch the builder proposes. It is never applied destructively:
 * `applied` is `false` whenever the patch came back from a dry-run apply (the
 * default), so an operator reviews the unified `diff` before any write.
 */
export interface ReviewablePatch {
  /** Whether the proposed change validated cleanly through the apply route. */
  readonly ok: boolean
  /** Unified diff against the workflow's executable source, for preview. */
  readonly diff?: string
  /** True only when a non-dry-run apply actually wrote; false for every dry-run. */
  readonly applied: boolean
  /** True when the proposal was a dry-run (no write performed). */
  readonly dryRun: boolean
  /** Managed-revision id, present only when a non-dry-run apply cut a revision. */
  readonly revision?: string
  /** Refusal reason when the round-trip declined the edit (e.g. code-owned). */
  readonly reason?: GraphEditFailureReason
  /** Human-readable detail accompanying a refusal. */
  readonly detail?: string
}

/** Outcome of running `skelm validate` against a candidate workflow. */
export interface ValidationOutcome {
  /** True when validate reported no blocking issues (exit code 0). */
  readonly valid: boolean
  /** Raw stdout from the validate run. */
  readonly stdout: string
  /** Raw stderr from the validate run. */
  readonly stderr: string
  /** Process exit code from the validate run. */
  readonly exitCode: number
}

/**
 * The gateway round-trip apply route the builder writes through. The persistent
 * entrypoint wires a bearer-authed HTTP client to the gateway; tests inject a
 * fake. The builder NEVER touches workflow source files directly — every edit
 * goes through this route so it is audited, validated, and codeOwned-preserving.
 */
export interface ApplyRoute {
  /** GET /v1/workflows/:id/graph — read-only graph derivation. */
  deriveGraph(workflowId: string): Promise<WorkflowGraph>
  /**
   * POST /v1/workflows/:id/source/apply. `dryRun` defaults to `true`; a call
   * that does not explicitly pass `dryRun: false` never writes.
   */
  applyEdits(
    workflowId: string,
    edits: readonly GraphEdit[],
    options?: { dryRun?: boolean },
  ): Promise<ReviewablePatch>
}

/** Runs `skelm validate <path>` for a candidate workflow file. */
export type ValidateRunner = (sourcePath: string) => Promise<ValidationOutcome>

/** Reads + discovers workflow source files under the project root. */
export interface ProjectSource {
  /** Project root the builder is scoped to. All reads/writes stay inside it. */
  readonly root: string
  /** List workflow files under the project (absolute paths). */
  listWorkflowFiles(): Promise<readonly string[]>
  /** Read a workflow file. Refuses any path outside the project root. */
  readFile(path: string): Promise<string>
}
