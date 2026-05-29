import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AgentRequest,
  type AgentResponse,
  type BackendCapabilities,
  type BackendContext,
  BackendRegistry,
  type SkelmBackend,
} from '../src/backend.js'
import { agent, pipeline } from '../src/builders.js'
import { runPipeline } from '../src/runner.js'

function makeAgentBackend(id: string): SkelmBackend & { calls: AgentRequest[] } {
  const calls: AgentRequest[] = []
  const capabilities: BackendCapabilities = {
    prompt: false,
    streaming: false,
    sessionLifecycle: false,
    mcp: false,
    skills: false,
    modelSelection: false,
    toolPermissions: 'unsupported',
  }
  return {
    id,
    capabilities,
    calls,
    async run(req: AgentRequest, _ctx: BackendContext): Promise<AgentResponse> {
      calls.push(req)
      return { text: 'ok' }
    },
  } as SkelmBackend & { calls: AgentRequest[] }
}

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs.length = 0
})

async function makeAgentDefDir(opts: { instructions: string; soul?: string }): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'skelm-agentdef-'))
  dirs.push(base)
  const agentDir = join(base, 'agents', 'support')
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(agentDir, 'AGENTS.md'), opts.instructions, 'utf8')
  if (opts.soul !== undefined) await writeFile(join(agentDir, 'SOUL.md'), opts.soul, 'utf8')
  return base
}

describe('agent() agentDef loading', () => {
  it('loads AGENTS.md + SOUL.md and threads them onto the backend request', async () => {
    const baseDir = await makeAgentDefDir({
      instructions: 'Always answer in haiku.',
      soul: 'You are a serene poet.',
    })
    const backend = makeAgentBackend('agent')
    const reg = new BackendRegistry()
    reg.register(backend)

    const wf = pipeline({
      id: 'agentdef-ok',
      baseDir,
      steps: [agent({ id: 'reply', backend: 'agent', agentDef: './agents/support', prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('completed')
    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0]?.agentDef).toEqual({
      name: 'support',
      instructions: 'Always answer in haiku.',
      soul: 'You are a serene poet.',
    })
  })

  it('omits soul when SOUL.md is absent', async () => {
    const baseDir = await makeAgentDefDir({ instructions: 'Be terse.' })
    const backend = makeAgentBackend('agent')
    const reg = new BackendRegistry()
    reg.register(backend)

    const wf = pipeline({
      id: 'agentdef-no-soul',
      baseDir,
      steps: [agent({ id: 'reply', backend: 'agent', agentDef: './agents/support', prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('completed')
    expect(backend.calls[0]?.agentDef).toEqual({ name: 'support', instructions: 'Be terse.' })
  })

  it('fails the step when a relative agentDef has no pipeline base dir to resolve against', async () => {
    const backend = makeAgentBackend('agent')
    const reg = new BackendRegistry()
    reg.register(backend)

    const wf = pipeline({
      id: 'agentdef-no-base',
      steps: [agent({ id: 'reply', backend: 'agent', agentDef: './agents/support', prompt: 'hi' })],
    })
    const run = await runPipeline(wf, undefined, { backends: reg })

    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('AgentDefinitionError')
    expect(backend.calls).toHaveLength(0)
  })
})
