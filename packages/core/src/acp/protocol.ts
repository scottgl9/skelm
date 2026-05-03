// Agent Client Protocol — wire types.
//
// ACP is JSON-RPC 2.0 over stdio. Agents in the wild currently use either
// Content-Length frames or newline-delimited JSON, and Copilot expects JSONL
// requests on stdin. Skelm acts as the *client*; the agent (claude-code,
// copilot --acp, etc.) is the server.
//
// We re-implement the protocol here; nothing is vendored. References are
// limited to the public Agent Client Protocol specification.

export const PROTOCOL_VERSION = 1

/** A single line in a streaming agent reply. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'audio'; mimeType: string; data: string }
  | { type: 'resource_link'; uri: string; mimeType?: string; name?: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } }

/** Reasons a session/prompt response can complete. */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | string

// ── JSON-RPC envelopes ──────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0'
  id: number | string
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

// ── Initialize ──────────────────────────────────────────────────────────────

export interface InitializeRequest {
  protocolVersion: number
  clientCapabilities?: ClientCapabilities
}

export interface ClientCapabilities {
  fs?: {
    readTextFile?: boolean
    writeTextFile?: boolean
  }
  terminal?: boolean
}

export interface InitializeResponse {
  protocolVersion: number
  agentCapabilities?: AgentCapabilities
  authMethods?: ReadonlyArray<{ id: string; name: string; description?: string }>
}

export interface AgentCapabilities {
  loadSession?: boolean
  promptCapabilities?: {
    image?: boolean
    audio?: boolean
    embeddedContext?: boolean
  }
  mcpCapabilities?: {
    http?: boolean
    sse?: boolean
  }
}

// ── Session ─────────────────────────────────────────────────────────────────

export interface SessionNewRequest {
  cwd: string
  mcpServers?: ReadonlyArray<McpServerSpec>
}

export type McpServerSpec =
  | {
      type: 'stdio'
      name: string
      command: string
      args?: readonly string[]
      env?: ReadonlyArray<{ name: string; value: string }>
    }
  | {
      type: 'http'
      name: string
      url: string
      headers?: ReadonlyArray<{ name: string; value: string }>
    }
  | {
      type: 'sse'
      name: string
      url: string
      headers?: ReadonlyArray<{ name: string; value: string }>
    }

export interface SessionNewResponse {
  sessionId: string
}

export interface SessionPromptRequest {
  sessionId: string
  prompt: ReadonlyArray<ContentBlock>
}

export interface SessionPromptResponse {
  stopReason: StopReason
}

// ── Notifications ───────────────────────────────────────────────────────────

/**
 * `session/update` — agent emits incremental updates during a prompt. We
 * type the union loosely because agents can extend it; consumers match on
 * sessionUpdate.kind and ignore unknown kinds.
 */
export interface SessionUpdateParams {
  sessionId: string
  update: SessionUpdate
}

export type SessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock }
  | { sessionUpdate: 'user_message_chunk'; content: ContentBlock }
  | {
      sessionUpdate: 'tool_call'
      toolCallId: string
      title?: string
      kind?: string
      status?: 'pending' | 'in_progress' | 'completed' | 'failed'
      content?: ReadonlyArray<ContentBlock>
      rawInput?: unknown
      rawOutput?: unknown
    }
  | {
      sessionUpdate: 'tool_call_update'
      toolCallId: string
      status?: 'pending' | 'in_progress' | 'completed' | 'failed'
      title?: string
      content?: ReadonlyArray<ContentBlock>
      rawOutput?: unknown
    }
  | { sessionUpdate: 'plan'; entries: ReadonlyArray<unknown> }
  | { sessionUpdate: string; [k: string]: unknown }

// ── Cancellation ────────────────────────────────────────────────────────────

export interface SessionCancelParams {
  sessionId: string
}
