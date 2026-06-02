import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BackendContext,
  BackendRegistry,
  type NetworkPolicy,
  type SkelmBackend,
  persistentWorkflow,
} from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway, InMemoryQueueDriver } from '../src/index.js'

// Per-workflow project permissions: `skelm run <dir>` activation pins the
// project's defaults.permissions to THAT project's workflows only. Two
// projects active on the same gateway must not cross-contaminate ceilings.
// Persistent AND regular workflows both honor the per-workflow registration
// (the routing happens in Gateway.defaultPermissionRunOptions(workflowId)).

interface SeenTurn {
  /** Tag of the backend that actually handled this run. */
  backendTag: string
  /** Prompt the backend received — uniquely identifies the firing workflow
   *  in these tests, since each driver pushes a distinct `text:` payload. */
  prompt: string
  allowedExecutables: readonly string[]
  networkEgress: NetworkPolicy | undefined
}

function capturingBackend(seen: SeenTurn[], backendTag: string): SkelmBackend {
  return {
    id: `cap-${backendTag}`,
    capabilities: {
      prompt: true,
      run: true,
      streaming: false,
      sessionLifecycle: false,
      mcp: false,
      skills: false,
      modelSelection: false,
      toolPermissions: 'native',
    },
    async run(request, context: BackendContext) {
      seen.push({
        backendTag,
        prompt: typeof request.prompt === 'string' ? request.prompt : '',
        allowedExecutables: [...(context.permissions?.allowedExecutables ?? [])],
        networkEgress: context.permissions?.networkEgress,
      })
      return { text: 'ok' }
    },
  }
}

let projectRoot: string
let stateDir: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pwp-'))
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-pwp-state-'))
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  await fs.writeFile(join(projectRoot, 'workflows/a.workflow.mts'), 'export default {}')
  await fs.writeFile(join(projectRoot, 'workflows/b.workflow.mts'), 'export default {}')
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

describe('per-workflow project permissions', () => {
  it('scopes a registered project ceiling to ONLY its workflow id', async () => {
    const seen: SeenTurn[] = []
    const registry = new BackendRegistry()
    registry.register(capturingBackend(seen, 'a'))
    registry.register(capturingBackend(seen, 'b'))

    const botA = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot-a',
      agent: {
        backend: 'cap-a',
        sessionKey: (p) => p.chatId,
        // Agent declares an unconstrained 'allow' + an exec it would need.
        permissions: {
          networkEgress: 'allow',
          allowedExecutables: ['skelm', 'node'],
        },
      },
    })
    const botB = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot-b',
      agent: {
        backend: 'cap-b',
        sessionKey: (p) => p.chatId,
        permissions: {
          networkEgress: 'allow',
          allowedExecutables: ['skelm', 'node'],
        },
      },
    })

    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      backends: registry,
      auditWriter: { write: async () => {} },
      config: {
        registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
      },
      loadWorkflow: async (id) => ({
        default: id.endsWith('a.workflow.mts') ? botA : botB,
      }),
    })
    await gw.start()

    // Project-A ceiling: only 'node' is allowed AND networkEgress is 'allow'.
    // Project-B has no project-level ceiling registered → falls back to gateway
    // defaults (none) → only the agent's grants bind.
    gw.registerWorkflowProjectPermissions('bot-a', {
      defaultPermissions: { networkEgress: 'allow', allowedExecutables: ['node'] },
    })

    const driverA = new InMemoryQueueDriver()
    const driverB = new InMemoryQueueDriver()
    gw.managers.triggers.registerQueueDriver('memqA', driverA)
    gw.managers.triggers.registerQueueDriver('memqB', driverB)
    gw.managers.triggers.register({
      kind: 'queue',
      id: 'qA',
      workflowId: 'workflows/a.workflow.mts',
      driver: 'memqA',
    })
    gw.managers.triggers.register({
      kind: 'queue',
      id: 'qB',
      workflowId: 'workflows/b.workflow.mts',
      driver: 'memqB',
    })

    driverA.push({ chatId: 'a1', text: 'hi-a' })
    await new Promise((r) => setTimeout(r, 200))
    driverB.push({ chatId: 'b1', text: 'hi-b' })
    await new Promise((r) => setTimeout(r, 200))

    expect(seen).toHaveLength(2)
    // Identify each turn by the unique payload text — the payload is what we
    // pushed onto a specific driver, so it tags the firing workflow without
    // having to round-trip through BackendContext (which doesn't expose
    // pipelineId). Each agent explicitly declares its own `backend:`, so the
    // backendTag check ALSO confirms routing didn't cross-fire.
    const turnA = seen.find((t) => t.prompt === 'hi-a')
    const turnB = seen.find((t) => t.prompt === 'hi-b')
    expect(turnA).toBeDefined()
    expect(turnB).toBeDefined()
    expect(turnA?.backendTag).toBe('a')
    expect(turnB?.backendTag).toBe('b')

    // bot-a sees the intersection of project-A ceiling × agent grants:
    //   allowedExecutables: ['node'] (skelm narrowed out by the ceiling),
    //   networkEgress: 'allow'.
    expect(turnA?.allowedExecutables).toEqual(['node'])
    expect(turnA?.networkEgress).toBe('allow')

    // bot-b sees ONLY the agent's grants — project-A's ceiling did not leak.
    // allowedExecutables stays at the agent's declared set; networkEgress stays
    // at the agent's 'allow'.
    expect(turnB?.allowedExecutables).toEqual(['skelm', 'node'])
    expect(turnB?.networkEgress).toBe('allow')

    await gw.stop()
  })

  it('scopes a registered project default backend to ONLY its workflow id', async () => {
    // Two backends registered. With no per-workflow default, the runtime
    // falls through to "first backend with run()" — non-deterministic across
    // configs. With per-workflow defaults set, each workflow's omitted
    // `backend:` resolves to ITS OWN project's choice.
    const seen: SeenTurn[] = []
    const registry = new BackendRegistry()
    registry.register(capturingBackend(seen, 'a'))
    registry.register(capturingBackend(seen, 'b'))

    const botA = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot-a',
      agent: {
        // No `backend:` — relies on the per-workflow default.
        sessionKey: (p) => p.chatId,
        permissions: { networkEgress: 'allow' },
      },
    })
    const botB = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot-b',
      agent: {
        sessionKey: (p) => p.chatId,
        permissions: { networkEgress: 'allow' },
      },
    })

    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      backends: registry,
      auditWriter: { write: async () => {} },
      config: {
        registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
      },
      loadWorkflow: async (id) => ({
        default: id.endsWith('a.workflow.mts') ? botA : botB,
      }),
    })
    await gw.start()

    gw.registerWorkflowProjectBackends('bot-a', { defaultAgentBackend: 'cap-a' })
    gw.registerWorkflowProjectBackends('bot-b', { defaultAgentBackend: 'cap-b' })

    const driverA = new InMemoryQueueDriver()
    const driverB = new InMemoryQueueDriver()
    gw.managers.triggers.registerQueueDriver('memqA', driverA)
    gw.managers.triggers.registerQueueDriver('memqB', driverB)
    gw.managers.triggers.register({
      kind: 'queue',
      id: 'qA',
      workflowId: 'workflows/a.workflow.mts',
      driver: 'memqA',
    })
    gw.managers.triggers.register({
      kind: 'queue',
      id: 'qB',
      workflowId: 'workflows/b.workflow.mts',
      driver: 'memqB',
    })

    driverA.push({ chatId: 'a1', text: 'hi-a' })
    await new Promise((r) => setTimeout(r, 200))
    driverB.push({ chatId: 'b1', text: 'hi-b' })
    await new Promise((r) => setTimeout(r, 200))

    expect(seen).toHaveLength(2)
    // The substantive claim: bot-a's `backend:`-less agent step resolved to
    // cap-a (its project's registered default), and bot-b's resolved to
    // cap-b — NOT first-with-run() (which would land both on cap-a since
    // registry insertion order would deterministically pick it). The
    // distinct payload texts identify which workflow caused each call;
    // backendTag identifies which backend was actually invoked.
    const turnA = seen.find((t) => t.prompt === 'hi-a')
    const turnB = seen.find((t) => t.prompt === 'hi-b')
    expect(turnA).toBeDefined()
    expect(turnB).toBeDefined()
    expect(turnA?.backendTag).toBe('a')
    expect(turnB?.backendTag).toBe('b')

    await gw.stop()
  })

  it('falls back to gateway-wide defaults when no per-workflow registration exists', async () => {
    const seen: SeenTurn[] = []
    const registry = new BackendRegistry()
    registry.register(capturingBackend(seen, 'a'))

    const bot = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot-a',
      agent: {
        backend: 'cap-a',
        sessionKey: (p) => p.chatId,
        permissions: { networkEgress: 'allow', allowedExecutables: ['skelm', 'node'] },
      },
    })

    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      backends: registry,
      auditWriter: { write: async () => {} },
      config: {
        registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
        // Operator-wide ceiling: narrows allowedExecutables to just 'skelm'.
        defaults: {
          permissions: { networkEgress: 'allow', allowedExecutables: ['skelm'] },
        },
      },
      loadWorkflow: async () => ({ default: bot }),
    })
    await gw.start()

    const driver = new InMemoryQueueDriver()
    gw.managers.triggers.registerQueueDriver('memq', driver)
    gw.managers.triggers.register({
      kind: 'queue',
      id: 'qA',
      workflowId: 'workflows/a.workflow.mts',
      driver: 'memq',
    })

    driver.push({ chatId: 'a1', text: 'hi' })
    await new Promise((r) => setTimeout(r, 120))

    expect(seen).toHaveLength(1)
    expect(seen[0]?.allowedExecutables).toEqual(['skelm'])
    expect(seen[0]?.networkEgress).toBe('allow')
    await gw.stop()
  })
})
