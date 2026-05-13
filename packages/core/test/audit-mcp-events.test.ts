import { describe, expect, it } from 'vitest'
import {
  type AgentRequest,
  type AgentResponse,
  type BackendCapabilities,
  type BackendContext,
  BackendRegistry,
  type SkelmBackend,
} from '../src/backend.js'
import { agent, pipeline } from '../src/builders.js'
import type { AuditEvent, AuditWriter } from '../src/enforcement/index.js'
import { runPipeline } from '../src/runner.js'

class RecordingAuditWriter implements AuditWriter {
  readonly entries: AuditEvent[] = []
  async write(entry: AuditEvent): Promise<void> {
    this.entries.push(entry)
  }
}

const echoCapabilities: BackendCapabilities = {
  prompt: false,
  streaming: false,
  sessionLifecycle: false,
  mcp: true,
  skills: false,
  modelSelection: false,
  toolPermissions: 'wrapped',
}

function echoBackend(): SkelmBackend {
  return {
    id: 'echo-backend',
    capabilities: echoCapabilities,
    async run(req: AgentRequest, ctx: BackendContext): Promise<AgentResponse> {
      const result = await ctx.mcpHost?.invokeTool('echo.tick', { v: req.prompt }, ctx.signal)
      return {
        text: (result?.content[0] as { type: 'text'; text: string } | undefined)?.text ?? '',
      }
    },
  }
}

describe('runPipeline auditWriter — MCP events', () => {
  it('records permission.denied when MCP attach is refused', async () => {
    const reg = new BackendRegistry()
    reg.register(echoBackend())
    const audit = new RecordingAuditWriter()
    const wf = pipeline({
      id: 'mcp-denied',
      steps: [
        agent({
          id: 'work',
          backend: 'echo-backend',
          mcp: [{ id: 'echo', transport: 'stdio', command: 'node', args: ['-e', '1'] }],
          permissions: { allowedMcpServers: [] },
          prompt: 'hi',
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, { backends: reg, auditWriter: audit })
    expect(run.status).toBe('failed')
    const mcpDenials = audit.entries.filter(
      (e) =>
        e.action === 'permission.denied' &&
        (e.details as { dimension?: string }).dimension === 'mcp',
    )
    expect(mcpDenials.length).toBeGreaterThan(0)
  })
})
