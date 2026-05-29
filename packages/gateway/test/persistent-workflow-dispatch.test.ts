import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentPermissions,
  type BackendContext,
  BackendRegistry,
  type PersistentSessionRecord,
  type SkelmBackend,
  agent,
  code,
  loadSession,
  persistentWorkflow,
  pipeline,
} from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway, InMemoryQueueDriver, createTriggerDispatcher } from '../src/index.js'

interface SeenTurn {
  prompt: string
  system?: string
  agentDef?: { name: string; instructions: string; soul?: string }
  unrestricted?: boolean
  allowedExecutables?: string[]
}

// Echo backend: returns the prompt as text and records the system prompt +
// resolved permission flags the runtime handed it, so the test can assert
// conversation continuity and the gated bypass against the REAL enforcement.
function echoBackend(seen: SeenTurn[]): SkelmBackend {
  return {
    id: 'echo',
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
        prompt: typeof request.prompt === 'string' ? request.prompt : '',
        ...(request.system !== undefined && { system: request.system }),
        ...(request.agentDef !== undefined && { agentDef: request.agentDef }),
        unrestricted: context.permissions?.unrestricted === true,
        allowedExecutables: [...(context.permissions?.allowedExecutables ?? [])],
      })
      return { text: `echo:${typeof request.prompt === 'string' ? request.prompt : ''}` }
    },
  }
}

interface AuditEntry {
  action: string
  details?: Record<string, unknown>
}

let projectRoot: string
let stateDir: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pw-'))
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-pw-state-'))
  // The dispatcher resolves the trigger's workflowId against the registry
  // before loading it, so the file must exist for the glob to index it. Its
  // contents are irrelevant — loadWorkflow is stubbed to return the workflow.
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  await fs.writeFile(join(projectRoot, 'workflows/bot.workflow.mts'), 'export default {}')
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

async function bootGateway(opts: {
  seen: SeenTurn[]
  audit: AuditEntry[]
  workflowModule: unknown
  unrestrictedGrants?: readonly string[]
  defaultPermissions?: AgentPermissions
}): Promise<Gateway> {
  const registry = new BackendRegistry()
  registry.register(echoBackend(opts.seen))
  const hasDefaults = opts.unrestrictedGrants !== undefined || opts.defaultPermissions !== undefined
  const gw = new Gateway({
    stateDir,
    projectRoot,
    watchRegistries: false,
    backends: registry,
    auditWriter: {
      write: async (entry: AuditEntry) => {
        opts.audit.push(entry)
      },
    },
    config: {
      registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
      ...(hasDefaults && {
        defaults: {
          ...(opts.unrestrictedGrants !== undefined && {
            unrestrictedGrants: opts.unrestrictedGrants,
          }),
          ...(opts.defaultPermissions !== undefined && { permissions: opts.defaultPermissions }),
        },
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

describe('persistent-workflow dispatch', () => {
  it('runs one turn and posts the reply via the queue driver onResult', async () => {
    const seen: SeenTurn[] = []
    const audit: AuditEntry[] = []
    const bot = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot',
      agent: { backend: 'echo', system: 'You are a bot.', sessionKey: (p) => p.chatId },
    })
    const gw = await bootGateway({ seen, audit, workflowModule: { default: bot } })
    const driver = wireQueue(gw)
    const replies: Array<{ payload: unknown; output: unknown }> = []
    driver.onResult = (payload, output) => replies.push({ payload, output })

    driver.push({ chatId: 'c1', text: 'hello' })
    await new Promise((r) => setTimeout(r, 80))

    expect(seen).toHaveLength(1)
    expect(seen[0]?.prompt).toBe('hello')
    expect(replies).toEqual([
      { payload: { chatId: 'c1', text: 'hello' }, output: { reply: 'echo:hello' } },
    ])
    await gw.stop()
  })

  it('runs preamble steps fresh each fire and feeds their output to the terminal prompt', async () => {
    const seen: SeenTurn[] = []
    const audit: AuditEntry[] = []
    const bot = persistentWorkflow<{ chatId: string; from: string; text: string }>({
      id: 'bot',
      steps: [
        code({
          id: 'prepare',
          run: (ctx) => {
            const msg = ctx.input as { from: string; text: string }
            return { text: `[${msg.from}] ${msg.text}` }
          },
        }),
      ],
      agent: {
        backend: 'echo',
        sessionKey: (p) => p.chatId,
        prompt: (ctx) => (ctx.steps.prepare as { text: string }).text,
      },
    })
    const gw = await bootGateway({ seen, audit, workflowModule: { default: bot } })
    const driver = wireQueue(gw)

    driver.push({ chatId: 'c1', from: 'alice', text: 'hello' })
    await new Promise((r) => setTimeout(r, 80))

    // The terminal turn saw the preamble-enriched text, not the raw payload.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.prompt).toBe('[alice] hello')

    // And the enriched text is what's persisted as the user message.
    const rec = (await loadSession(gw.runStore, 'bot', 'c1')) as PersistentSessionRecord
    expect(rec.turns).toBe(1)
    expect((rec.conversation as Array<{ role: string; content: string }>)[0]).toEqual({
      role: 'user',
      content: '[alice] hello',
    })
    await gw.stop()
  })

  it('persists a preamble-fed conversation across fires for the same session key', async () => {
    const seen: SeenTurn[] = []
    const audit: AuditEntry[] = []
    const bot = persistentWorkflow<{ chatId: string; from: string; text: string }>({
      id: 'bot',
      steps: [
        code({
          id: 'prepare',
          run: (ctx) => ({
            text: `[${(ctx.input as { from: string }).from}] ${(ctx.input as { text: string }).text}`,
          }),
        }),
      ],
      agent: {
        backend: 'echo',
        sessionKey: (p) => p.chatId,
        prompt: (ctx) => (ctx.steps.prepare as { text: string }).text,
      },
    })
    const gw = await bootGateway({ seen, audit, workflowModule: { default: bot } })
    const driver = wireQueue(gw)

    driver.push({ chatId: 'c1', from: 'alice', text: 'first' })
    await new Promise((r) => setTimeout(r, 80))
    driver.push({ chatId: 'c1', from: 'alice', text: 'second' })
    await new Promise((r) => setTimeout(r, 80))

    // The second turn's system prompt carries the prior (enriched) exchange.
    expect(seen).toHaveLength(2)
    expect(seen[1]?.system).toContain('[alice] first')
    expect(seen[1]?.system).toContain('echo:[alice] first')

    const rec = (await loadSession(gw.runStore, 'bot', 'c1')) as PersistentSessionRecord
    expect(rec.turns).toBe(2)
    expect((rec.conversation as unknown[]).length).toBe(4)
    await gw.stop()
  })

  it('does not save the session when a preamble step fails', async () => {
    const seen: SeenTurn[] = []
    const audit: AuditEntry[] = []
    const bot = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot',
      steps: [
        code({
          id: 'prepare',
          run: () => {
            throw new Error('preamble boom')
          },
        }),
      ],
      agent: { backend: 'echo', sessionKey: (p) => p.chatId },
    })
    const gw = await bootGateway({ seen, audit, workflowModule: { default: bot } })
    const driver = wireQueue(gw)

    driver.push({ chatId: 'c1', text: 'hi' })
    await new Promise((r) => setTimeout(r, 80))

    // The terminal turn never ran, and no partial conversation was persisted.
    expect(seen).toHaveLength(0)
    await expect(loadSession(gw.runStore, 'bot', 'c1')).resolves.toBeUndefined()
    await gw.stop()
  })

  it('persists conversation across fires for the same session key (no preamble)', async () => {
    const seen: SeenTurn[] = []
    const audit: AuditEntry[] = []
    const bot = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot',
      agent: { backend: 'echo', sessionKey: (p) => p.chatId },
    })
    const gw = await bootGateway({ seen, audit, workflowModule: { default: bot } })
    const driver = wireQueue(gw)

    driver.push({ chatId: 'c1', text: 'first' })
    await new Promise((r) => setTimeout(r, 80))
    driver.push({ chatId: 'c1', text: 'second' })
    await new Promise((r) => setTimeout(r, 80))

    // The second turn's system prompt carries the prior exchange.
    expect(seen).toHaveLength(2)
    expect(seen[1]?.system).toContain('first')
    expect(seen[1]?.system).toContain('echo:first')

    const rec = (await loadSession(gw.runStore, 'bot', 'c1')) as PersistentSessionRecord
    expect(rec.turns).toBe(2)
    expect((rec.conversation as unknown[]).length).toBe(4)
    // sessionId is stable across the two fires.
    expect(rec.sessionId).toMatch(/[0-9a-f-]{36}/)
    await gw.stop()
  })

  it('isolates conversations by session key', async () => {
    const seen: SeenTurn[] = []
    const audit: AuditEntry[] = []
    const bot = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot',
      agent: { backend: 'echo', sessionKey: (p) => p.chatId },
    })
    const gw = await bootGateway({ seen, audit, workflowModule: { default: bot } })
    const driver = wireQueue(gw)

    driver.push({ chatId: 'a', text: 'hey-a' })
    await new Promise((r) => setTimeout(r, 80))
    driver.push({ chatId: 'b', text: 'hey-b' })
    await new Promise((r) => setTimeout(r, 80))

    const a = (await loadSession(gw.runStore, 'bot', 'a')) as PersistentSessionRecord
    const b = (await loadSession(gw.runStore, 'bot', 'b')) as PersistentSessionRecord
    expect(a.sessionId).not.toBe(b.sessionId)
    expect(a.turns).toBe(1)
    expect(b.turns).toBe(1)
    await gw.stop()
  })

  it('denies the unrestricted bypass when the operator has not granted it', async () => {
    const seen: SeenTurn[] = []
    const audit: AuditEntry[] = []
    const bot = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'assistant',
      agent: {
        backend: 'echo',
        permissions: { requestUnrestricted: true },
        sessionKey: (p) => p.chatId,
      },
    })
    const gw = await bootGateway({ seen, audit, workflowModule: { default: bot } }) // no grants
    const driver = wireQueue(gw)
    driver.push({ chatId: 'c1', text: 'hi' })
    await new Promise((r) => setTimeout(r, 80))

    expect(seen[0]?.unrestricted).toBe(false)
    expect(audit.some((e) => e.action === 'permission.bypassed')).toBe(false)
    await gw.stop()
  })

  it('grants the unrestricted bypass when the operator allowlisted the workflow id, and audits it', async () => {
    const seen: SeenTurn[] = []
    const audit: AuditEntry[] = []
    const bot = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'assistant',
      agent: {
        backend: 'echo',
        permissions: { requestUnrestricted: true },
        sessionKey: (p) => p.chatId,
      },
    })
    const gw = await bootGateway({
      seen,
      audit,
      workflowModule: { default: bot },
      unrestrictedGrants: ['assistant'],
    })
    const driver = wireQueue(gw)
    driver.push({ chatId: 'c1', text: 'hi' })
    await new Promise((r) => setTimeout(r, 80))

    expect(seen[0]?.unrestricted).toBe(true)
    expect(audit.some((e) => e.action === 'permission.bypassed')).toBe(true)
    await gw.stop()
  })

  it('applies config.defaults.permissions as an intersection ceiling on a persistent turn', async () => {
    const seen: SeenTurn[] = []
    const audit: AuditEntry[] = []
    const bot = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot',
      agent: {
        backend: 'echo',
        permissions: { allowedExecutables: ['git', 'rm'] },
        sessionKey: (p) => p.chatId,
      },
    })
    const gw = await bootGateway({
      seen,
      audit,
      workflowModule: { default: bot },
      defaultPermissions: { allowedExecutables: ['git'] }, // operator ceiling
    })
    const driver = wireQueue(gw)
    driver.push({ chatId: 'c1', text: 'hi' })
    await new Promise((r) => setTimeout(r, 80))

    // The agent asked for git+rm; the operator ceiling is git-only ⇒ intersect to git.
    expect(seen[0]?.allowedExecutables).toEqual(['git'])
    await gw.stop()
  })

  it('applies config.defaults.permissions to a gateway-run pipeline (the previously-dormant gap)', async () => {
    const seen: SeenTurn[] = []
    const audit: AuditEntry[] = []
    const wf = pipeline({
      id: 'echo-pipeline',
      steps: [
        agent({
          id: 'a',
          backend: 'echo',
          prompt: 'hi',
          permissions: { allowedExecutables: ['git', 'rm'] },
        }),
      ],
    })
    const gw = await bootGateway({
      seen,
      audit,
      workflowModule: { default: wf },
      defaultPermissions: { allowedExecutables: ['git'] },
    })
    const driver = wireQueue(gw)
    driver.push({ chatId: 'c1', text: 'hi' })
    await new Promise((r) => setTimeout(r, 80))

    expect(seen[0]?.allowedExecutables).toEqual(['git'])
    await gw.stop()
  })

  it('loads agent.agentDef (AGENTS.md/SOUL.md) relative to the workflow file and threads it to the turn', async () => {
    const seen: SeenTurn[] = []
    const audit: AuditEntry[] = []
    // agentDef resolves against the workflow file's directory (workflows/).
    const agentDir = join(projectRoot, 'workflows', 'agents', 'assistant')
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(join(agentDir, 'AGENTS.md'), 'Be a meticulous assistant.', 'utf8')
    await fs.writeFile(join(agentDir, 'SOUL.md'), 'You are unflappably calm.', 'utf8')

    const bot = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot',
      agent: { backend: 'echo', agentDef: './agents/assistant', sessionKey: (p) => p.chatId },
    })
    const gw = await bootGateway({ seen, audit, workflowModule: { default: bot } })
    const driver = wireQueue(gw)
    driver.push({ chatId: 'c1', text: 'hi' })
    await new Promise((r) => setTimeout(r, 80))

    expect(seen).toHaveLength(1)
    expect(seen[0]?.agentDef).toEqual({
      name: 'assistant',
      instructions: 'Be a meticulous assistant.',
      soul: 'You are unflappably calm.',
    })
    await gw.stop()
  })
})
