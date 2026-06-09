// Agentmemory types consumed by backends and the gateway.
// Kept separate from the rest of the backend SPI so packages that only need
// the agentmemory contract (e.g. @skelm/agentmemory) can import a narrow slice
// without pulling in inference / agent request shapes.

import type { AgentmemoryOperation, EnforceDecision } from '../permissions.js'

/**
 * Minimal interface backends consume; the concrete implementation lives in
 * `@skelm/agentmemory` and is wired by the gateway. Method bodies must be
 * cheap to call when the underlying server is unreachable — backends invoke
 * `observe` after every tool call and should never have the agent loop block
 * on memory I/O.
 */
export interface AgentmemoryHandle {
  /** Start a session at agent launch; idempotent on the session id. */
  startSession(input: {
    sessionId: string
    project?: string
    cwd?: string
    model?: string
    tags?: readonly string[]
  }): Promise<void>
  /** Mark the session ended at dispose; idempotent. */
  endSession(input: { sessionId: string }): Promise<void>
  /**
   * Record an observation (tool use, file event, etc). Fire-and-forget from
   * the backend's perspective — the implementation absorbs network failures.
   */
  observe(input: {
    sessionId: string
    hookType: string
    data: unknown
    project?: string
    cwd?: string
  }): Promise<void>
  /**
   * Hybrid search (BM25 + vector + graph). Backends typically call this once
   * per turn to fetch context to prepend to the system prompt.
   */
  smartSearch(input: {
    query: string
    limit?: number
    sessionId?: string
  }): Promise<AgentmemorySearchResult>
  /**
   * Fetch a token-budgeted context block for direct prompt injection. The
   * upstream server requires a `sessionId`; omit only when you have none (the
   * call then returns an empty block rather than throwing).
   */
  context(input: {
    sessionId?: string
    project?: string
    query: string
    tokenBudget?: number
  }): Promise<AgentmemoryContextBlock>
  /**
   * Explicitly persist an insight (the author-driven counterpart to the
   * automatic `observe` capture). Custom step/backend code calls this; the
   * built-in backend loops do not.
   */
  save(input: {
    sessionId?: string
    project?: string
    title: string
    content: string
    concepts?: readonly string[]
  }): Promise<AgentmemorySaveResult>
  /** Recall recent or by-session memories (distinct from hybrid `smartSearch`). */
  recall(input: {
    sessionId?: string
    project?: string
    limit?: number
  }): Promise<AgentmemoryRecallResult>
  /** List recent sessions with highlights. */
  sessions(input: { project?: string; limit?: number }): Promise<AgentmemorySessionsResult>
  /** Traverse the knowledge graph over concepts, files, and patterns. */
  graphQuery(input: {
    project?: string
    query: string
    limit?: number
  }): Promise<AgentmemoryGraphResult>
}

export interface AgentmemorySearchHit {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly score?: number
  readonly concepts?: readonly string[]
}

export interface AgentmemorySearchResult {
  readonly hits: readonly AgentmemorySearchHit[]
}

export interface AgentmemoryContextBlock {
  readonly text: string
  readonly tokenEstimate?: number
}

export interface AgentmemorySaveResult {
  readonly id: string
}

export interface AgentmemoryRecallResult {
  readonly hits: readonly AgentmemorySearchHit[]
}

export interface AgentmemorySessionSummary {
  readonly id: string
  readonly title?: string
  readonly startedAt?: number
  readonly highlights?: readonly string[]
}

export interface AgentmemorySessionsResult {
  readonly sessions: readonly AgentmemorySessionSummary[]
}

export interface AgentmemoryGraphNode {
  readonly id: string
  readonly label: string
  readonly kind?: string
}

export interface AgentmemoryGraphEdge {
  readonly from: string
  readonly to: string
  readonly relation?: string
}

export interface AgentmemoryGraphResult {
  readonly nodes: readonly AgentmemoryGraphNode[]
  readonly edges: readonly AgentmemoryGraphEdge[]
}

/** Factory context handed to the gateway's per-step agentmemory factory. */
export interface AgentmemoryHandleFactoryContext {
  readonly runId: string
  readonly stepId: string
  /** Bound `TrustEnforcer.canUseAgentmemory` for the step's resolved policy. */
  readonly canUseAgentmemory: (op: AgentmemoryOperation) => EnforceDecision
  /** Optional event bus; the handle publishes permission.denied / agentmemory.error. */
  readonly events?: { publish(event: unknown): void }
}

/**
 * Factory returning a per-step `AgentmemoryHandle`. The gateway constructs
 * one of these from its `AgentmemoryClient` and hands it through
 * `RunOptions.agentmemoryHandleFactory`. Undefined disables the integration.
 */
export type AgentmemoryHandleFactory = (
  ctx: AgentmemoryHandleFactoryContext,
) => AgentmemoryHandle | undefined
