import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BackendRegistry,
  type SkelmBackend,
  agent,
  createMcpHost,
  pipeline,
  runPipeline,
} from '../../src/index.js'

const MOCK_MCP = fileURLToPath(new URL('./mock-mcp-server.ts', import.meta.url))

describe('MCP host', () => {
  it('lists tools and invokes them over stdio', async () => {
    const host = await createMcpHost([
      {
        id: 'echo',
        transport: 'stdio',
        command: 'node',
        args: ['--import', 'tsx/esm', MOCK_MCP],
      },
    ])
    try {
      const tools = await host.listTools()
      expect(tools).toEqual([
        expect.objectContaining({
          id: 'echo.echo',
          serverId: 'echo',
          name: 'echo',
        }),
      ])

      const result = await host.invokeTool('echo.echo', { text: 'hello' })
      expect(result.content).toEqual([{ type: 'text', text: 'echo:hello' }])
    } finally {
      await host.dispose()
    }
  })

  it('lists tools and invokes them over HTTP', async () => {
    const server = await startHttpMcpServer()
    const host = await createMcpHost([
      {
        id: 'remote',
        transport: 'http',
        url: server.url,
      },
    ])
    try {
      const tools = await host.listTools()
      expect(tools).toEqual([
        expect.objectContaining({
          id: 'remote.echo',
          serverId: 'remote',
          name: 'echo',
        }),
      ])

      const result = await host.invokeTool('remote.echo', { text: 'hello' })
      expect(result.content).toEqual([{ type: 'text', text: 'http:hello' }])
    } finally {
      await host.dispose()
      await server.close()
    }
  })

  it('injects mcpHost into wrapped-tool backends', async () => {
    const reg = new BackendRegistry()
    const backend: SkelmBackend = {
      id: 'wrapped',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: true,
        skills: false,
        modelSelection: false,
        toolPermissions: 'wrapped',
      },
      async run(req, ctx) {
        const tools = await ctx.mcpHost?.listTools()
        expect(tools.map((tool) => tool.id)).toEqual(['echo.echo'])
        const result = await ctx.mcpHost?.invokeTool('echo.echo', { text: req.prompt }, ctx.signal)
        return { text: (result.content[0] as { type: 'text'; text: string }).text }
      },
    }
    reg.register(backend)

    const wf = pipeline({
      id: 'wrapped-mcp',
      steps: [
        agent({
          id: 'work',
          backend: 'wrapped',
          mcp: [
            {
              id: 'echo',
              transport: 'stdio',
              command: 'node',
              args: ['--import', 'tsx/esm', MOCK_MCP],
            },
          ],
          permissions: { allowedTools: ['echo.echo'], allowedMcpServers: ['echo'] },
          prompt: 'hi',
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, { backends: reg })
    expect(run.status).toBe('completed')
    expect((run.output as { text: string }).text).toBe('echo:hi')
  })

  it('fails when a backend declares no mcp capability but the step attaches servers', async () => {
    const reg = new BackendRegistry()
    reg.register({
      id: 'no-mcp',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'wrapped',
      },
      async run() {
        return { text: 'unreachable' }
      },
    })

    const wf = pipeline({
      id: 'no-mcp',
      steps: [
        agent({
          id: 'work',
          backend: 'no-mcp',
          mcp: [
            {
              id: 'echo',
              transport: 'stdio',
              command: 'node',
              args: ['--import', 'tsx/esm', MOCK_MCP],
            },
          ],
          permissions: { allowedMcpServers: ['echo'] },
          prompt: 'hi',
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, { backends: reg })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('BackendCapabilityError')
    expect(run.error?.message).toMatch(/does not support per-step MCP attachments/)
  })
})

async function startHttpMcpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const message = raw.length === 0 ? undefined : (JSON.parse(raw) as Record<string, unknown>)
    const id = message?.id as number | string | undefined
    const method = message?.method as string | undefined

    if (method === 'notifications/initialized') {
      res.writeHead(204)
      res.end()
      return
    }

    if (id === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing id' }))
      return
    }

    if (method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'mock-http-mcp', version: '0.1.0' },
          },
        }),
      )
      return
    }

    if (method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'echo',
                description: 'Echo text back over HTTP',
              },
            ],
          },
        }),
      )
      return
    }

    if (method === 'tools/call') {
      const params = message?.params as { arguments?: { text?: string } } | undefined
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `http:${params?.arguments?.text ?? ''}` }],
            isError: false,
          },
        }),
      )
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } }),
    )
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('expected TCP server address')
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}
