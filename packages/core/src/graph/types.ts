// Read-only WorkflowGraph AST derived from a Pipeline or PersistentWorkflow.
//
// The graph is the public contract the dashboard graph viewer and the future
// visual block editor consume. It is a pure, serializable projection of the
// authored workflow: the TypeScript source stays the single source of truth,
// and the graph is always re-derived from it. Author code that cannot be
// safely round-tripped to source (inline `run`/predicate functions) is flagged
// `codeOwned` so the editor never attempts to rewrite it.

import type { StepKind } from '../types-base.js'

/** A node kind: every step kind plus the two synthetic boundary nodes. */
export type GraphNodeKind = StepKind | 'trigger' | 'finalize'

/**
 * Redacted summary of a step's declared permissions. Carries which dimensions
 * are present plus profile / executable-profile NAMES only — never any secret
 * value. Mirrors the human-readable strings `introspect` already produces so
 * consumers render one representation.
 */
export interface AgentPermissionsSummary {
  /** Permission dimensions the step declares (e.g. `tool`, `executable`). */
  readonly dimensions: readonly string[]
  /** Named project permission profile, when set. */
  readonly profile?: string
  /** Named executable profiles referenced by the step, when set. */
  readonly executableProfiles?: readonly string[]
}

/** A single node in the workflow graph. */
export interface GraphNode {
  readonly id: string
  readonly kind: GraphNodeKind
  readonly label?: string
  readonly summary?: string
  /** Redacted permission summary; present only when the step declares permissions. */
  readonly permissions?: AgentPermissionsSummary
  /**
   * True when the node wraps arbitrary author code that cannot be safely
   * round-tripped to source (an inline `code.run`, a `branch.on`/`loop.while`
   * predicate, a `forEach` step factory). The visual editor must never rewrite
   * these regions.
   */
  readonly codeOwned?: boolean
  /** Nested sub-steps for control-flow containers. */
  readonly children?: readonly GraphNode[]
  /** Small, kind-specific, JSON-serializable detail. Never functions or secrets. */
  readonly data?: Record<string, unknown>
}

/** A directed edge between two nodes. */
export interface GraphEdge {
  readonly from: string
  readonly to: string
  readonly kind: 'control' | 'data'
  readonly label?: string
}

/** The derived, read-only workflow graph. */
export interface WorkflowGraph {
  readonly id: string
  readonly version?: string
  readonly kind: 'pipeline' | 'persistent-workflow'
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly meta?: Record<string, unknown>
}
