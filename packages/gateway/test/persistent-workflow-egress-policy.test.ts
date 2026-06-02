import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentPermissions,
  type BackendContext,
  BackendRegistry,
  type NetworkPolicy,
  type SkelmBackend,
  createRoutingBackend,
  persistentWorkflow,
} from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway, InMemoryQueueDriver } from '../src/index.js'

// Regression for the silent failure I hit while running `skelm builder`:
// every turn died with PermissionDeniedError from the pi-sdk failover
// ("backend cannot enforce networkEgress in-process. Set networkEgress:
// \"allow\"") even though both `defaults.permissions.networkEgress` AND
// `agent.permissions.networkEgress` were `'allow'`. These tests pin the
// invariant that the resolved policy the backend sees has `'allow'` when
// both layers declare `'allow'`.

interface SeenTurn {
  networkEgress: NetworkPolicy | undefined
}

function capturingBackend(seen: SeenTurn[]): SkelmBackend {
  return {
    id: 'capture',
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
      seen.push({ networkEgress: context.permissions?.networkEgress })
      return { text: 'ok' }
    },
  }
}

let projectRoot: string
let stateDir: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pw-egress-'))
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-pw-egress-state-'))
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  await fs.writeFile(join(projectRoot, 'workflows/bot.workflow.mts'), 'export default {}')
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

async function bootGateway(opts: {
  seen: SeenTurn[]
  workflowModule: unknown
  defaultPermissions?: AgentPermissions
}): Promise<Gateway> {
  const registry = new BackendRegistry()
  registry.register(capturingBackend(opts.seen))
  const gw = new Gateway({
    stateDir,
    projectRoot,
    watchRegistries: false,
    backends: registry,
    auditWriter: { write: async () => {} },
    config: {
      registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
      ...(opts.defaultPermissions !== undefined && {
        defaults: { permissions: opts.defaultPermissions },
      }),
    },
    loadWorkflow: async () => opts.workflowModule,
  })
  await gw.start()
  return gw
}

function wireQueue(gw: Gateway): InMemoryQueueDriver {
  const driver = new InMemoryQueueDriver()
  gw.managers.triggers.registerQueueDriver('memq', driver)
  gw.managers.triggers.register({
    kind: 'queue',
    id: 'q',
    workflowId: 'workflows/bot.workflow.mts',
    driver: 'memq',
  })
  return driver
}

describe('persistent-workflow resolved networkEgress', () => {
  it("preserves 'allow' when both defaults and the agent declare 'allow'", async () => {
    const seen: SeenTurn[] = []
    const bot = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot',
      agent: {
        backend: 'capture',
        sessionKey: (p) => p.chatId,
        permissions: {
          networkEgress: 'allow',
          fsRead: ['./'],
          fsWrite: ['./'],
          allowedExecutables: ['node'],
        },
      },
    })
    const gw = await bootGateway({
      seen,
      workflowModule: { default: bot },
      defaultPermissions: {
        networkEgress: 'allow',
        fsRead: ['./'],
        fsWrite: ['./'],
        allowedExecutables: ['node'],
      },
    })
    const driver = wireQueue(gw)
    driver.push({ chatId: 'c1', text: 'hi' })
    await new Promise((r) => setTimeout(r, 120))

    expect(seen).toHaveLength(1)
    expect(seen[0]?.networkEgress).toBe('allow')
    await gw.stop()
  })

  it("preserves 'allow' through a routing-backend's failover (codex→pi-sdk shape)", async () => {
    // Mirrors the builder's createRoutingBackend(primary=codex, failover=[piSdk])
    // shape. The primary throws an error-without-name so isRetryable falls
    // over, and the failover's context must still see networkEgress='allow'.
    const seen: SeenTurn[] = []
    const primaryFails: SkelmBackend = {
      id: 'primary',
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
      async run() {
        throw new Error('primary unavailable')
      },
    }
    const router = createRoutingBackend({
      id: 'routed',
      primary: primaryFails,
      failover: [capturingBackend(seen)],
    })
    const registry = new BackendRegistry()
    registry.register(router)
    const bot = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot',
      agent: {
        backend: 'routed',
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
        defaults: { permissions: { networkEgress: 'allow' } },
      },
      loadWorkflow: async () => ({ default: bot }),
    })
    await gw.start()
    const driver = wireQueue(gw)
    driver.push({ chatId: 'c1', text: 'hi' })
    await new Promise((r) => setTimeout(r, 200))

    expect(seen).toHaveLength(1)
    expect(seen[0]?.networkEgress).toBe('allow')
    await gw.stop()
  })

  it("preserves 'allow' when only the agent declares it (no operator default)", async () => {
    const seen: SeenTurn[] = []
    const bot = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot',
      agent: {
        backend: 'capture',
        sessionKey: (p) => p.chatId,
        permissions: { networkEgress: 'allow' },
      },
    })
    const gw = await bootGateway({ seen, workflowModule: { default: bot } })
    const driver = wireQueue(gw)
    driver.push({ chatId: 'c1', text: 'hi' })
    await new Promise((r) => setTimeout(r, 120))

    expect(seen).toHaveLength(1)
    expect(seen[0]?.networkEgress).toBe('allow')
    await gw.stop()
  })
})
