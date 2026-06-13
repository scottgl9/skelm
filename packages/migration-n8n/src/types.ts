/**
 * Types for the n8n workflow JSON import pipeline.
 *
 * The shapes here describe the subset of an n8n workflow export we read.
 * n8n exports carry many fields we ignore; parsing is deliberately tolerant
 * of unknown fields (see {@link parseN8nWorkflow}) and only the fields below
 * are load-bearing for the mapping.
 */

/** A node as it appears in an n8n workflow JSON export. */
export interface N8nNode {
  /** Unique node name within the workflow (n8n uses the name as the id key). */
  readonly name: string
  /** Fully-qualified n8n node type, e.g. `n8n-nodes-base.httpRequest`. */
  readonly type: string
  /** Node type version; informational. */
  readonly typeVersion?: number
  /** Node parameters (opaque, node-type-specific). */
  readonly parameters?: Record<string, unknown>
  /** Editor position `[x, y]`; preserved for deterministic ordering. */
  readonly position?: readonly [number, number]
  /** Whether the node is disabled in the n8n editor. */
  readonly disabled?: boolean
}

/** A single downstream connection target inside an n8n `connections` map. */
export interface N8nConnectionTarget {
  readonly node: string
  readonly type?: string
  readonly index?: number
}

/**
 * n8n connections map: source node name → output kind (`main`) → array of
 * output slots → array of targets. We read the `main` output only.
 */
export type N8nConnections = Record<
  string,
  Record<string, ReadonlyArray<ReadonlyArray<N8nConnectionTarget>>>
>

/** A parsed, validated n8n workflow export. */
export interface N8nWorkflow {
  readonly name: string
  readonly nodes: readonly N8nNode[]
  readonly connections: N8nConnections
}

/** Which skelm builder a node maps onto. */
export type SkelmStepKind =
  | 'code'
  | 'branch'
  | 'parallel'
  | 'invoke'
  | 'infer'
  | 'agent'
  | 'trigger'
  | 'unsupported'

/** A skelm trigger kind a node maps onto (when {@link SkelmStepKind} is `trigger`). */
export type SkelmTriggerKind = 'webhook' | 'interval' | 'cron'

/** The result of mapping a single n8n node to a skelm step equivalent. */
export interface MappedNode {
  /** The original n8n node. */
  readonly source: N8nNode
  /** Sanitized, unique step id used in generated code. */
  readonly stepId: string
  /** Which skelm builder this node maps onto. */
  readonly kind: SkelmStepKind
  /** For `trigger` kinds, the concrete trigger flavor. */
  readonly triggerKind?: SkelmTriggerKind
  /** skelm integration package this node needs, when one exists. */
  readonly integration?: string
  /** A short human note describing the mapping decision. */
  readonly note: string
  /**
   * True when no mapping exists. Such enabled nodes are emitted as TODO
   * comments in the skeleton and listed under
   * {@link MigrationResult.unsupported}; disabled n8n nodes are omitted
   * earlier during mapping so they stay inert.
   */
  readonly unsupported: boolean
}

/** The full outcome of importing an n8n workflow. */
export interface MigrationResult {
  /** Sanitized skelm pipeline id derived from the workflow name. */
  readonly pipelineId: string
  /** Per-node mapping decisions, in deterministic node order. */
  readonly nodes: readonly MappedNode[]
  /** Distinct skelm integration package names the skeleton needs. */
  readonly requiredIntegrations: readonly string[]
  /** Node names that could not be mapped and are flagged TODO in the skeleton. */
  readonly unsupported: readonly string[]
  /** The generated TypeScript skeleton source (a `pipeline(...)` module). */
  readonly source: string
  /**
   * Optional test-fixture stub generated from sample execution data, when the
   * export carried any. `undefined` when no sample data was present.
   */
  readonly fixture?: string
}

/** Options controlling a migration. */
export interface MigrateOptions {
  /**
   * Mapping overrides: n8n node `type` → skelm integration package name. Lets
   * an operator point an otherwise-unsupported node at a custom integration.
   */
  readonly integrationOverrides?: Readonly<Record<string, string>>
}
