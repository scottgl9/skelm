/**
 * Self-test for the `@skelm/coding-agent` package.
 *
 * Runs the coding-agent pipeline end-to-end against the package's tiny
 * fixture repo with a SCRIPTED stub backend — deterministic, no real LLM and
 * no repo mutation. Each `check()` asserts one guarantee; `summarizeChecks`
 * aggregates them into the package's `SectionResult`.
 */

import { fileURLToPath } from 'node:url'

import {
  type AgentRequest,
  type AgentResponse,
  type BackendCapabilities,
  type BackendContext,
  BackendRegistry,
  type SkelmBackend,
  TrustEnforcer,
  check,
  pipeline,
  runPipeline,
} from '@skelm/core'
import { summarizeChecks } from '@skelm/core/testing'

import { createCodingAgentWorkflow } from '@skelm/coding-agent'

const FIXTURE_REPO = fileURLToPath(new URL('../test/fixtures/repo', import.meta.url))

function stubBackend(): SkelmBackend & { calls: AgentRequest[] } {
  const calls: AgentRequest[] = []
  const capabilities: BackendCapabilities = {
    prompt: true,
    streaming: false,
    sessionLifecycle: false,
    mcp: true,
    skills: true,
    modelSelection: false,
    toolPermissions: 'native',
  }
  return {
    id: 'agent',
    capabilities,
    calls,
    async run(req: AgentRequest, _ctx: BackendContext): Promise<AgentResponse> {
      calls.push(req)
      return { text: 'done; validation passed', stopReason: 'stop' }
    },
  } as SkelmBackend & { calls: AgentRequest[] }
}

const checkIds = [
  'runs-end-to-end',
  'declares-workspace-scoped-writes',
  'pr-off-by-default',
] as const

export default pipeline({
  id: 'coding-agent-self-test',
  description: 'End-to-end self-test of @skelm/coding-agent on a fixture repo with a stub backend.',
  steps: [
    check({
      id: 'runs-end-to-end',
      run: async () => {
        const backend = stubBackend()
        const reg = new BackendRegistry()
        reg.register(backend)
        const wf = createCodingAgentWorkflow({
          workspace: FIXTURE_REPO,
          profile: { executableProfiles: ['nodeBuild'] },
        })
        const run = await runPipeline(
          wf,
          { task: 'add a helper' },
          {
            backends: reg,
            executableProfiles: { nodeBuild: { executables: ['node', 'pnpm'] } },
          },
        )
        if (run.status !== 'completed') throw new Error(`run status ${run.status}`)
        const out = run.output as { stack: string }
        if (out.stack !== 'node-pnpm') throw new Error(`stack ${out.stack}`)
        return out
      },
    }),
    check({
      id: 'declares-workspace-scoped-writes',
      run: async () => {
        const backend = stubBackend()
        const reg = new BackendRegistry()
        reg.register(backend)
        const wf = createCodingAgentWorkflow({
          workspace: FIXTURE_REPO,
          profile: { executableProfiles: ['nodeBuild'] },
        })
        await runPipeline(
          wf,
          { task: 'x' },
          {
            backends: reg,
            executableProfiles: { nodeBuild: { executables: ['node', 'pnpm'] } },
          },
        )
        const policy = backend.calls[0]?.permissions
        if (policy === undefined) throw new Error('agent step dispatched without a resolved policy')
        const enforcer = new TrustEnforcer(policy)
        if (enforcer.canWrite('/etc/passwd').allow) throw new Error('wrote outside workspace')
        if (!enforcer.canWrite(`${FIXTURE_REPO}/src/index.js`).allow) {
          throw new Error('cannot write inside workspace')
        }
        if (enforcer.canExec('rm').allow) throw new Error('exec outside profile allowed')
        return 'workspace-scoped'
      },
    }),
    check({
      id: 'pr-off-by-default',
      run: async () => {
        const backend = stubBackend()
        const reg = new BackendRegistry()
        reg.register(backend)
        const wf = createCodingAgentWorkflow({
          workspace: FIXTURE_REPO,
          profile: { executableProfiles: ['nodeBuild'] },
        })
        const run = await runPipeline(
          wf,
          { task: 'x' },
          {
            backends: reg,
            executableProfiles: { nodeBuild: { executables: ['node', 'pnpm'] } },
          },
        )
        const out = run.output as { prEnabled: boolean }
        if (out.prEnabled !== false) throw new Error('PR opening not off by default')
        return 'pr-off'
      },
    }),
  ],
  finalize: (ctx) => summarizeChecks('coding-agent', [...checkIds], ctx, ctx.run.startedAt),
})
