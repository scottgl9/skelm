export const MCP_PROTOCOL_VERSION = '2025-03-26'

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

export interface InitializeRequest {
  protocolVersion: string
  capabilities?: Record<string, unknown>
  clientInfo: {
    name: string
    version: string
  }
}

export interface InitializeResponse {
  protocolVersion: string
  capabilities?: {
    tools?: {
      listChanged?: boolean
    }
    [key: string]: unknown
  }
  serverInfo: {
    name: string
    version: string
  }
  instructions?: string
}

export interface ToolDefinition {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: Record<string, unknown>
}

export interface ToolsListResponse {
  tools: readonly ToolDefinition[]
  nextCursor?: string
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } }

export interface ToolCallResponse {
  content: readonly ToolContent[]
  isError?: boolean
  structuredContent?: unknown
}
