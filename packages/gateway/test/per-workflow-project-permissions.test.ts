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
  workflow: string
  allowedExecutables: readonly string[]
  networkEgress: NetworkPolicy | undefined
}

function capturingBackend(seen: SeenTurn[], workflowTag: string): SkelmBackend {
  return {
    id: `cap-${workflowTag}`,
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
    async run(_request, context: BackendContext) {
      seen.push({
        workflow: workflowTag,
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
    const turnA = seen.find((t) => t.workflow === 'a')
    const turnB = seen.find((t) => t.workflow === 'b')

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
