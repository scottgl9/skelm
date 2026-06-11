import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpClient, McpProtocolError } from '../../src/mcp/client.js'
import { MCP_PROTOCOL_VERSION } from '../../src/mcp/protocol.js'

describe('McpClient', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('times out hung HTTP requests', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as {
        id?: number | string
        method?: string
      }

      if (payload.method === 'initialize') {
        return jsonRpcResponse(payload.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          serverInfo: { name: 'mock-mcp', version: '1.0.0' },
        })
      }

      if (payload.method === 'notifications/initialized') {
        return new Response(null, { status: 204 })
      }

      return await new Promise<Response>(() => {})
    })

    const client = new McpClient()
    await client.connectHttp({
      url: 'http://mcp.test',
      fetch: fetchMock as unknown as typeof fetch,
      requestTimeoutMs: 5,
    })

    const request = client.listTools()
    const timedOut = expect(request).rejects.toThrow('MCP request "tools/list" timed out after 5ms')
    await vi.advanceTimersByTimeAsync(5)

    await timedOut
    await expect(request).rejects.toThrow(McpProtocolError)
  })
})

function jsonRpcResponse(id: number | string | undefined, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
