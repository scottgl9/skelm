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
          permissions: { allowedMcpServers: ['echo'] },
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
