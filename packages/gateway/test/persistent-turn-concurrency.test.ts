// Regression: a persistent-agent trigger must not serialize fires across
// distinct sessionKeys. Two back-to-back queue pushes with different chatIds
// target independent durable sessions, so both turns must run; only same-
// session fires need to serialize (and that ordering is guarded by the
// per-session lock inside runPersistentTurn).
//
// Pre-fix behaviour: TriggerCoordinator.fire() observes inflight=true on the
// second push and, under the default overlap='skip', drops it on the floor —
// so only the first session's turn ever runs.

import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendRegistry, type SkelmBackend, persistentAgent } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway, InMemoryQueueDriver } from '../src/index.js'

interface SeenTurn {
  prompt: string
}

// A deliberately slow echo backend: holds the first turn open for ~150ms so
// the second push lands while the first is still inflight. That is the race
// the harness exercised and that the production fix has to survive.
function slowEchoBackend(seen: SeenTurn[], holdMs = 150): SkelmBackend {
  return {
    id: 'slow-echo',
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
    async run(request) {
      const prompt = typeof request.prompt === 'string' ? request.prompt : ''
      seen.push({ prompt })
      await new Promise((r) => setTimeout(r, holdMs))
      return { text: `echo:${prompt}` }
    },
  }
}

let projectRoot: string
let stateDir: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-pa-conc-'))
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-pa-conc-state-'))
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  await fs.writeFile(join(projectRoot, 'workflows/bot.workflow.mts'), 'export default {}')
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(message)
}

describe('persistent-agent dispatch concurrency', () => {
  it('runs two back-to-back fires with distinct sessionKeys concurrently', async () => {
    const seen: SeenTurn[] = []
    const registry = new BackendRegistry()
    registry.register(slowEchoBackend(seen))
    const bot = persistentAgent<{ chatId: string; text: string }>({
      id: 'bot',
      backend: 'slow-echo',
      sessionKey: (p) => p.chatId,
      promptOf: (p) => p.text,
    })
    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      backends: registry,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.mts' } } },
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

      driver.push({ chatId: 'a', text: 'hey-a' })
      driver.push({ chatId: 'b', text: 'hey-b' })

      await waitFor(
        () => seen.length === 2,
        'expected two backend invocations for two distinct sessionKeys',
      )
      expect(seen.map((s) => s.prompt).sort()).toEqual(['hey-a', 'hey-b'])
    } finally {
      await gw.stop()
    }
  })

  it('still serializes turns within a single sessionKey (one turn at a time)', async () => {
    // The first turn holds the backend open. While it is still running, push a
    // second turn for the SAME chatId. The within-session lock must keep them
    // ordered: when the second turn starts, the first has already returned.
    const seen: Array<{ prompt: string; startedAt: number; doneAt: number }> = []
    const registry = new BackendRegistry()
    const holdMs = 120
    registry.register({
      id: 'serial-echo',
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
      async run(request) {
        const prompt = typeof request.prompt === 'string' ? request.prompt : ''
        const startedAt = Date.now()
        await new Promise((r) => setTimeout(r, holdMs))
        const doneAt = Date.now()
        seen.push({ prompt, startedAt, doneAt })
        return { text: `echo:${prompt}` }
      },
    })
    const bot = persistentAgent<{ chatId: string; text: string }>({
      id: 'bot',
      backend: 'serial-echo',
      sessionKey: (p) => p.chatId,
      promptOf: (p) => p.text,
    })
    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      backends: registry,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.mts' } } },
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

      driver.push({ chatId: 'c1', text: 'one' })
      driver.push({ chatId: 'c1', text: 'two' })

      await waitFor(() => seen.length === 2, 'expected two turns for the same sessionKey')
      // Second turn must start strictly after the first finishes.
      const first = seen.find((s) => s.prompt === 'one')
      const second = seen.find((s) => s.prompt === 'two')
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      if (first !== undefined && second !== undefined) {
        expect(second.startedAt).toBeGreaterThanOrEqual(first.doneAt)
      }
    } finally {
      await gw.stop()
    }
  })
})
