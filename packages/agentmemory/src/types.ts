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

export interface HealthResponse {
  ok: boolean
  version?: string
}
