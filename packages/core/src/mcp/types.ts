/**
 * Public MCP server configuration shape, hoisted into a leaf module so
 * `backend.ts` and `mcp/host.ts` can both depend on it without forming
 * a circular import.
 */
export type McpServerConfig =
  | {
      id: string
      transport: 'stdio'
      command: string
      args?: readonly string[]
      env?: Readonly<Record<string, string>>
    }
  | {
      id: string
      transport: 'http' | 'sse'
      url: string
      headers?: Readonly<Record<string, string>>
    }
