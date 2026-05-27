// Public types mirroring the agentmemory REST contract (v0.9.x).
// Kept narrow: only the fields skelm sends or reads.

export type AgentmemoryHookType =
  | 'session_start'
  | 'session_end'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'post_tool_failure'
  | 'user_prompt_submit'
  | 'subagent_start'
  | 'subagent_stop'
  | 'notification'
  | 'task_completed'
  | 'pre_compact'
  | 'stop'

export interface HookPayload {
  hookType: AgentmemoryHookType | string
  sessionId: string
  project: string
  cwd: string
  timestamp: string
  data: unknown
}

export interface SmartSearchRequest {
  query: string
  limit?: number
  sessionId?: string
}

export interface SmartSearchHit {
  id: string
  title: string
  content: string
  score?: number
  concepts?: readonly string[]
}

export interface SmartSearchResponse {
  hits: readonly SmartSearchHit[]
}

export interface ContextRequest {
  sessionId: string
  project: string
  query: string
  token_budget?: number
}

export interface ContextResponse {
  text: string
  tokenEstimate?: number
}

export interface SessionStartRequest {
  sessionId: string
  project: string
  cwd: string
  model?: string
  tags?: readonly string[]
}

export interface SessionEndRequest {
  sessionId: string
}

/**
 * Liveness result for the agentmemory server. `ok` reflects that `/health`
 * answered 2xx — a reachability probe, not deep health. The upstream server
 * returns a rich metrics object with no top-level `ok`/`version`; the client
 * synthesizes `ok` from the HTTP status and only surfaces `version` when the
 * server provides one.
 */
export interface HealthResponse {
  ok: boolean
  version?: string
}

export interface MemorySaveRequest {
  session_id?: string
  project: string
  title: string
  content: string
  concepts?: readonly string[]
}

export interface MemorySaveResponse {
  id: string
}

export interface MemoryRecallRequest {
  session_id?: string
  project: string
  limit?: number
}

export interface MemoryRecallResponse {
  hits: readonly SmartSearchHit[]
}

export interface SessionsListRequest {
  project?: string
  limit?: number
}

export interface SessionSummary {
  id: string
  title?: string
  startedAt?: number
  highlights?: readonly string[]
}

export interface SessionsListResponse {
  sessions: readonly SessionSummary[]
}

export interface GraphQueryRequest {
  project: string
  query: string
  limit?: number
}

export interface GraphNode {
  id: string
  label: string
  kind?: string
}

export interface GraphEdge {
  from: string
  to: string
  relation?: string
}

export interface GraphQueryResponse {
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
}
