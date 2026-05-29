import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BackendContext,
  BackendRegistry,
  type ExecFn,
  type SkelmBackend,
  code,
  persistentWorkflow,
} from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway, InMemoryQueueDriver } from '../../src/index.js'

// Adversarial: a persistent workflow's `agent.permissions` (including the
// unrestricted bypass) apply ONLY to the terminal turn. Preamble steps carry
// their own declared permissions and stay default-deny even when the operator
// has granted the workflow id the bypass. Widening preamble permissions via the
// terminal grant would be a silent permission escalation — this proves it can't
// happen, against the REAL gateway enforcement path.

interface SeenTurn {
  unrestricted: boolean
}

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
      seen.push({ unrestricted: context.permissions?.unrestricted === true })
      return { text: `echo:${typeof request.prompt === 'string' ? request.prompt : ''}` }
    },
  }
}

interface AuditEntry {
  action: string
}

let projectRoot: string
let stateDir: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pw-sec-'))
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-pw-sec-state-'))
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  await fs.writeFile(join(projectRoot, 'workflows/bot.workflow.mts'), 'export default {}')
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

describe('persistent-workflow preamble permission isolation', () => {
  it('denies a privileged op in a preamble step even when the workflow id is granted unrestricted, while the terminal turn gets the bypass', async () => {
    const seen: SeenTurn[] = []
    const audit: AuditEntry[] = []
    const registry = new BackendRegistry()
    registry.register(echoBackend(seen))

    const bot = persistentWorkflow<{ chatId: string; text: string }>({
      id: 'bot',
      steps: [
        code({
          id: 'prepare',
          // No permissions declared, and no requestUnrestricted: default-deny.
          // continueOnError lets the run reach the terminal turn so we can prove
          // BOTH the preamble denial and the terminal bypass in one run.
          continueOnError: true,
          run: async (ctx) => {
            await (ctx.exec as ExecFn)({
              command: 'node',
              args: ['-e', 'process.stdout.write("never")'],
            })
            return {}
          },
        }),
      ],
      agent: {
        backend: 'echo',
        // Only the terminal turn requests the bypass.
        permissions: { requestUnrestricted: true },
        sessionKey: (p) => p.chatId,
      },
    })

    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      backends: registry,
      auditWriter: {
        write: async (entry: AuditEntry) => {
          audit.push(entry)
        },
      },
      config: {
        registries: { workflows: { glob: 'workflows/**/*.workflow.mts' } },
        defaults: { unrestrictedGrants: ['bot'] },
      },
      loadWorkflow: async () => ({ default: bot }),
    })
    await gw.start()
    try {
      const driver = new InMemoryQueueDriver()
      gw.managers.triggers.registerQueueDriver('memq', driver)
      gw.managers.triggers.register({
        kind: 'queue',
        id: 'q',
        workflowId: 'workflows/bot.workflow.mts',
        driver: 'memq',
      })

      driver.push({ chatId: 'c1', text: 'hi' })
      await new Promise((r) => setTimeout(r, 120))

      // Preamble exec was denied despite the workflow being granted unrestricted.
      expect(audit.some((e) => e.action === 'permission.denied')).toBe(true)
      // The terminal turn DID receive the bypass.
      expect(seen).toHaveLength(1)
      expect(seen[0]?.unrestricted).toBe(true)
      expect(audit.some((e) => e.action === 'permission.bypassed')).toBe(true)
    } finally {
      await gw.stop()
    }
  })
})
