import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BackendRegistry,
  EventBus,
  PermissionDeniedError,
  type RunEvent,
  type SkelmBackend,
  agent,
  pipeline,
  runPipeline,
} from '../../src/index.js'

const MOCK_SHELL_MCP = fileURLToPath(new URL('./mock-shell-mcp-server.ts', import.meta.url))

describe('permission enforcement — adversarial', () => {
  it('allows rg but denies bash for wrapped MCP exec tools', async () => {
    const registry = new BackendRegistry()
    const backend: SkelmBackend = {
      id: 'wrapped-exec',
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
        if (req.prompt === 'allowed') {
          const result = await ctx.mcpHost?.invokeTool(
            'shell.exec',
            { command: 'rg --version' },
            ctx.signal,
          )
          return { text: (result?.content[0] as { type: 'text'; text: string }).text }
        }

        await ctx.mcpHost?.invokeTool('shell.exec', { command: 'bash -lc "echo nope"' }, ctx.signal)
        return { text: 'unreachable' }
      },
    }
    registry.register(backend)

    const allowedRun = await runPipeline(workflow('allowed'), undefined, { backends: registry })
    expect(allowedRun.status).toBe('completed')
    expect((allowedRun.output as { text: string }).text).toBe('exec:rg --version')

    const events = new EventBus()
    const seen: RunEvent[] = []
    events.subscribe((event) => {
      seen.push(event)
    })

    const deniedRun = await runPipeline(workflow('denied'), undefined, {
      backends: registry,
      events,
    })
    expect(deniedRun.status).toBe('failed')
    expect(deniedRun.error?.name).toBe('PermissionDeniedError')
    expect(deniedRun.error?.message).toMatch(/requested executable "bash"/)
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.denied',
          stepId: 'work',
          tool: 'shell.exec',
          reason: 'not-in-allowlist',
        }),
        expect.objectContaining({
          type: 'permission.denied',
          stepId: 'work',
          dimension: 'executable',
        }),
      ]),
    )
  })

  it('emits permission.denied when the backend defense-in-depth guard throws PermissionDeniedError', async () => {
    // Simulates a backend like Pi RPC that cannot enforce policies itself and
    // rejects any non-undefined ResolvedPolicy from within its own run() method.
    const registry = new BackendRegistry()
    const backend: SkelmBackend = {
      id: 'self-enforcing',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'unsupported',
      },
      async run(_req, ctx) {
        if (ctx.permissions !== undefined) {
          throw new PermissionDeniedError(
            'self-enforcing backend cannot enforce permission policies',
          )
        }
        return { text: 'ok' }
      },
    }
    registry.register(backend)

    const events = new EventBus()
    const seen: RunEvent[] = []
    events.subscribe((ev) => seen.push(ev))

    const run = await runPipeline(
      pipeline({
        id: 'defense-in-depth',
        steps: [
          agent({
            id: 'step',
            backend: 'self-enforcing',
            prompt: 'go',
            permissions: { allowedTools: [], networkEgress: 'deny' },
          }),
        ],
      }),
      undefined,
      { backends: registry, events },
    )

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('PermissionDeniedError')
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'permission.denied',
          stepId: 'step',
          dimension: 'tool',
        }),
      ]),
    )
  })
})

function workflow(prompt: string) {
  return pipeline({
    id: `permissions-${prompt}`,
    steps: [
      agent({
        id: 'work',
        backend: 'wrapped-exec',
        prompt,
        mcp: [
          {
            id: 'shell',
            transport: 'stdio',
            command: 'node',
            args: ['--import', 'tsx/esm', MOCK_SHELL_MCP],
          },
        ],
        permissions: {
          allowedTools: ['shell.exec'],
          allowedExecutables: ['rg'],
          allowedMcpServers: ['shell'],
        },
      }),
    ],
  })
}
