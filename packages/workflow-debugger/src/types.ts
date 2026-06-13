import type { RunEvent } from '@skelm/core'
import type { GraphNode, WorkflowGraph } from '@skelm/core'

/** One hash-chained audit row as returned by `GET /audit`. */
export interface AuditRow {
  readonly seq?: number
  readonly runId?: string
  readonly actor: string
  readonly action: string
  readonly data: unknown
  readonly at?: number | string
}

/** One artifact descriptor as returned by `GET /runs/:id/artifacts`. */
export interface ArtifactSummary {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly stepId?: string
  readonly sizeBytes?: number
}

/**
 * Read-only view of a failed run as seen through the gateway HTTP surface.
 * The debugger never executes a run; it only ingests one.
 */
export interface RunBundle {
  readonly runId: string
  readonly events: readonly RunEvent[]
  readonly audit: readonly AuditRow[]
  readonly artifacts: readonly ArtifactSummary[]
  /** Derived workflow graph, when the gateway could resolve it. */
  readonly graph?: WorkflowGraph
}

/**
 * The minimal gateway surface the debugger reads. Injected so tests can supply
 * a fake; the default implementation is {@link GatewayDebugHttpClient}, a thin
 * read-only HTTP client that authenticates by token reference (bearer).
 */
export interface GatewayDebugClient {
  getRun(runId: string): Promise<{ pipelineId?: string; status?: string } | null>
  getEvents(runId: string): Promise<readonly RunEvent[]>
  getAudit(runId: string): Promise<readonly AuditRow[]>
  getArtifacts(runId: string): Promise<readonly ArtifactSummary[]>
  /** Derived workflow graph for a registered workflow id; `null` when unavailable. */
  getWorkflowGraph(workflowId: string): Promise<WorkflowGraph | null>
  /**
   * Apply declarative graph edits through the dry-run-default apply route.
   * The debugger only ever calls this in dry-run mode; it never writes.
   */
  applyGraphEditsDryRun(workflowId: string, edits: readonly unknown[]): Promise<GraphEditPreview>
}

/** Result of a dry-run apply: a preview diff, never written. */
export interface GraphEditPreview {
  readonly ok: boolean
  readonly applied: false
  readonly dryRun: true
  readonly diff?: string
  readonly reason?: string
}

/**
 * Optional native-agent turn used to draft a remediation. Abstracted to a
 * single call so the debugger never hard-depends on a concrete backend and
 * tests can inject a deterministic stub. A turn returns prose plus an optional
 * set of declarative graph edits to preview.
 */
export interface FixProposalTurn {
  propose(input: FixProposalInput): Promise<FixProposalDraft>
}

export interface FixProposalInput {
  readonly runId: string
  readonly failingStep: FailingStep
  readonly evidence: readonly Evidence[]
  /** Redacted, human-readable summary of the failure for the model. */
  readonly summary: string
  readonly graph?: WorkflowGraph
}

export interface FixProposalDraft {
  /** Remediation prose. Must be already redacted by the producer. */
  readonly remediation: string
  /** Declarative graph edits to preview via the dry-run apply route, if any. */
  readonly edits?: readonly unknown[]
}

/** The step blamed for the failure. */
export interface FailingStep {
  readonly stepId: string
  readonly kind: string
  /** Error name + message, redacted. */
  readonly error: string
  /** Event seq that first surfaced the failure. */
  readonly atSeq?: number
  /** Graph node for the step, when the graph resolved it. */
  readonly node?: GraphNode
}

export type EvidenceKind =
  | 'step.error'
  | 'run.failed'
  | 'permission.denied'
  | 'tool.denied'
  | 'tool.error'
  | 'step.retry'
  | 'audit'
  | 'artifact'

/** A pointer into the source material backing a finding. Carries no secrets. */
export interface Evidence {
  readonly kind: EvidenceKind
  /** Event seq, audit seq, or artifact id, depending on `kind`. */
  readonly ref: string
  /** Redacted one-line description. */
  readonly detail: string
}

/** A reviewable, not-applied remediation. */
export interface SuggestedFix {
  /** Redacted remediation prose. */
  readonly remediation: string
  /** Whether an edit was proposed at all. */
  readonly hasEdit: boolean
  /** Always false — the debugger never applies edits. */
  readonly applied: false
  /** Always true — any edit is surfaced as a reviewable dry-run preview. */
  readonly reviewable: true
  /** Dry-run apply preview, present only when an edit was proposed. */
  readonly preview?: GraphEditPreview
}

/** Structured output of an analyze pass. Every string field is redacted. */
export interface DebugReport {
  readonly runId: string
  readonly pipelineId?: string
  readonly failingStep?: FailingStep
  /** Single-line root-cause hypothesis, redacted. */
  readonly rootCauseHypothesis: string
  readonly evidence: readonly Evidence[]
  /** Counts of correlated signals across the timeline. */
  readonly correlations: {
    readonly permissionDenials: number
    readonly toolDenials: number
    readonly toolErrors: number
    readonly retries: number
  }
  readonly suggestedFix?: SuggestedFix
}
