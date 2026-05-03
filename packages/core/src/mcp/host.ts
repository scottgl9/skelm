import type { McpServerConfig } from '../backend.js'
import { RunCancelledError } from '../errors.js'
import { McpClient } from './client.js'
import type { ToolCallResponse } from './protocol.js'

export interface McpHostedTool {
  id: string
  serverId: string
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: Record<string, unknown>
}

export interface McpHost {
  listTools(): Promise<readonly McpHostedTool[]>
  invokeTool(toolId: string, args: unknown, signal?: AbortSignal): Promise<ToolCallResponse>
  dispose(): Promise<void>
}

export async function createMcpHost(servers: readonly McpServerConfig[]): Promise<McpHost> {
  const clients = new Map<string, McpClient>()

  try {
    for (const server of servers) {
      if (server.transport !== 'stdio') {
        throw new Error(`MCP host supports stdio servers only in this stage (${server.id})`)
      }
      const client = new McpClient()
      await client.start({
        command: server.command,
        ...(server.args !== undefined && { args: server.args }),
        ...(server.env !== undefined && { env: server.env }),
      })
      clients.set(server.id, client)
    }
  } catch (err) {
    for (const client of clients.values()) {
      await client.stop()
    }
    throw err
  }

  return {
    async listTools(): Promise<readonly McpHostedTool[]> {
      const tools: McpHostedTool[] = []
      for (const [serverId, client] of clients) {
        const listed = await client.listTools()
        for (const tool of listed.tools) {
          tools.push({
            id: `${serverId}.${tool.name}`,
            serverId,
            name: tool.name,
            ...(tool.description !== undefined && { description: tool.description }),
            ...(tool.inputSchema !== undefined && { inputSchema: tool.inputSchema }),
            ...(tool.annotations !== undefined && { annotations: tool.annotations }),
          })
        }
      }
      return tools
    },
    async invokeTool(
      toolId: string,
      args: unknown,
      signal?: AbortSignal,
    ): Promise<ToolCallResponse> {
      const dot = toolId.indexOf('.')
      if (dot < 1 || dot === toolId.length - 1) {
        throw new Error(`invalid MCP tool id: ${toolId}`)
      }
      const serverId = toolId.slice(0, dot)
      const toolName = toolId.slice(dot + 1)
      const client = clients.get(serverId)
      if (!client) {
        throw new Error(`unknown MCP server: ${serverId}`)
      }
      return await awaitWithAbort(client.callTool(toolName, args), signal)
    },
    async dispose(): Promise<void> {
      await Promise.all([...clients.values()].map((client) => client.stop()))
      clients.clear()
    },
  }
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise
  if (signal.aborted) throw new RunCancelledError()
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new RunCancelledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
