// Public ACP surface re-exported from @skelm/core for plugin authors and
// advanced embedders. Most customers reach this through agent() steps.

export { createAcpBackend } from './backend.js'
export type { AcpBackendOptions } from './backend.js'
export { AcpClient, AcpProtocolError } from './client.js'
export type { AcpPromptResult, AcpSpawnOptions } from './client.js'
export { JsonRpcStdioTransport } from './transport.js'
export {
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type ClientCapabilities,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpServerSpec,
  type SessionNewRequest,
  type SessionNewResponse,
  type SessionPromptRequest,
  type SessionPromptResponse,
  type SessionUpdate,
  type StopReason,
} from './protocol.js'
