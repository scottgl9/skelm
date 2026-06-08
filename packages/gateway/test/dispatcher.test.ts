import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BackendRegistry,
  type RunEvent,
  type SkelmBackend,
  code,
  infer,
  pipeline,
} from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Gateway,
  InMemoryQueueDriver,
  TriggerCoordinator,
  createTriggerDispatcher,
} from '../src/index.js'

let projectRoot: string
let stateDir: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-disp-'))
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-disp-state-'))
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  await fs.writeFile(join(projectRoot, 'workflows/hello.workflow.mts'), 'export default {}')
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('condition was not met before timeout')
}

describe('createTriggerDispatcher', () => {
  it('resolves workflowId via the registry, imports via the loader, and runs it', async () => {
    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
    })
    await gw.start()

    const ran: string[] = []
    const fakePipeline = pipeline({
      id: 'hello',
      steps: [
        code({
          id: 'step',
          run: () => {
            ran.push('step')
            return {}
          },
        }),
      ],
    })

    const dispatcher = createTriggerDispatcher({
      gateway: gw,
      loadWorkflow: async (id) => {
        expect(id).toBe('workflows/hello.workflow.mts')
        return { default: fakePipeline }
      },
    })

    const coordinator = new TriggerCoordinator({ onFire: dispatcher })
    coordinator.register({
      kind: 'manual',
      id: 'm',
      workflowId: 'workflows/hello.workflow.mts',
    })
    await coordinator.fire('m')

    await waitFor(() => ran.length === 1)
    expect(ran).toEqual(['step'])
    await coordinator.stop()
    await gw.stop()
  })

  it('passes payload as the pipeline input and invokes onResult with the run output', async () => {
    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
    })
    await gw.start()

    const seenInputs: unknown[] = []
    const fakePipeline = pipeline({
      id: 'echo',
      steps: [
        code({
          id: 'step',
          run: (ctx) => {
            seenInputs.push(ctx.input)
            return {}
          },
        }),
      ],
      finalize: (ctx) => ({ echoed: ctx.input }),
    })

    const dispatcher = createTriggerDispatcher({
      gateway: gw,
      loadWorkflow: async () => ({ default: fakePipeline }),
    })
    gw.managers.triggers.setOnFire(dispatcher)

    const driver = new InMemoryQueueDriver()
    const onResultSeen: Array<{ payload: unknown; output: unknown }> = []
    driver.onResult = (payload, output) => {
      onResultSeen.push({ payload, output })
    }

    gw.managers.triggers.registerQueueDriver('memq', driver)
    gw.managers.triggers.register({
      kind: 'queue',
      id: 'q',
      workflowId: 'workflows/hello.workflow.mts',
      driver: 'memq',
    })

    driver.push({ msg: 'hello' })
    await new Promise((r) => setTimeout(r, 50))

    expect(seenInputs).toEqual([{ msg: 'hello' }])
    expect(onResultSeen).toEqual([
      { payload: { msg: 'hello' }, output: { echoed: { msg: 'hello' } } },
    ])
    await gw.stop()
  })

  it('forwards run-stream events to a NON-persistent queue driver onEvent hook (streaming)', async () => {
    // Regression: onEvent was wired only for persistent-workflow turns; a plain
    // queue-triggered pipeline with a streaming step delivered nothing to the
    // driver's onEvent, so a streaming frontend bound to a regular workflow saw
    // no live deltas. The QueueDriver.onEvent contract is the same on every path.
    const streamingBackend: SkelmBackend = {
      id: 'stream',
      capabilities: {
        prompt: true,
        streaming: true,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'native',
      },
      async inference(_req, ctx) {
        for (const delta of ['Hel', 'lo ', 'wor', 'ld']) ctx.onPartial?.(delta)
        return { text: 'Hello world' }
      },
    }
    const backends = new BackendRegistry()
    backends.register(streamingBackend)

    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      backends,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
    })
    await gw.start()

    const wf = pipeline({
      id: 'stream-wf',
      steps: [infer({ id: 'gen', backend: 'stream', prompt: 'go' })],
    })

    const dispatcher = createTriggerDispatcher({
      gateway: gw,
      backends,
      loadWorkflow: async () => ({ default: wf }),
    })
    gw.managers.triggers.setOnFire(dispatcher)

    const partials: string[] = []
    let sawCompleted = false
    const driver = new InMemoryQueueDriver()
    driver.onEvent = (_payload, event: RunEvent) => {
      if (event.type === 'step.partial') partials.push(event.delta)
      if (event.type === 'run.completed') sawCompleted = true
    }

    gw.managers.triggers.registerQueueDriver('memq', driver)
    gw.managers.triggers.register({
      kind: 'queue',
      id: 'q',
      workflowId: 'workflows/hello.workflow.mts',
      driver: 'memq',
    })

    driver.push({ msg: 'go' })
    await new Promise((r) => setTimeout(r, 80))

    expect(partials.join('')).toBe('Hello world')
    expect(sawCompleted).toBe(true)
    await gw.stop()
  })

  it('runs a workflowId that is an absolute path to a file outside the registry', async () => {
    // `POST /schedules` accepts an absolute path to a workflow the gateway
    // never glob-indexed. The dispatcher must fall back to that path so the
    // fire actually starts a run instead of recording `workflow not
    // registered` while still reporting `dispatched`.
    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
    })
    await gw.start()

    const absPath = join(projectRoot, 'workflows/hello.workflow.mts')
    const ran: string[] = []
    const fakePipeline = pipeline({
      id: 'hello',
      steps: [
        code({
          id: 'step',
          run: () => {
            ran.push('step')
            return {}
          },
        }),
      ],
    })

    // The registry id is `workflows/hello.workflow.mts`; firing with the
    // absolute path is NOT a registry id, so resolution must use the path.
    expect(gw.registries.workflows.get(absPath)).toBeUndefined()

    const dispatcher = createTriggerDispatcher({
      gateway: gw,
      loadWorkflow: async (_id, abs) => {
        expect(abs).toBe(absPath)
        return { default: fakePipeline }
      },
    })
    const coordinator = new TriggerCoordinator({ onFire: dispatcher })
    coordinator.register({ kind: 'manual', id: 'abs', workflowId: absPath })
    await coordinator.fire('abs')

    await waitFor(() => ran.length === 1)
    expect(ran).toEqual(['step'])
    expect(coordinator.get('abs')?.lastError).toBeUndefined()
    await coordinator.stop()
    await gw.stop()
  })

  it('records lastOutcome=failed and lastErrorAt when the triggered pipeline fails', async () => {
    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
    })
    await gw.start()

    const failingPipeline = pipeline({
      id: 'always-fails',
      steps: [
        code({
          id: 'boom',
          run: () => {
            throw new Error('pipeline step failed deliberately')
          },
        }),
      ],
    })

    const errors: Error[] = []
    const dispatcher = createTriggerDispatcher({
      gateway: gw,
      loadWorkflow: async () => ({ default: failingPipeline }),
      onError: (err) => errors.push(err),
    })

    const coordinator = new TriggerCoordinator({ onFire: dispatcher })
    coordinator.register({
      kind: 'manual',
      id: 'fail-trigger',
      workflowId: 'workflows/hello.workflow.mts',
    })
    await coordinator.fire('fail-trigger')

    await waitFor(() => coordinator.get('fail-trigger')?.lastOutcome === 'failed')
    const reg = coordinator.get('fail-trigger')
    expect(reg?.lastOutcome).toBe('failed')
    expect(reg?.lastErrorAt).toBeDefined()
    expect(reg?.lastError).toMatch(/pipeline step failed deliberately/)
    await coordinator.stop()
    await gw.stop()
  })

  it('records lastError on the trigger when the workflow id is unknown', async () => {
    const gw = new Gateway({ stateDir, projectRoot, watchRegistries: false })
    await gw.start()
    const dispatcher = createTriggerDispatcher({
      gateway: gw,
      loadWorkflow: async () => ({}),
    })
    const coordinator = new TriggerCoordinator({ onFire: dispatcher })
    coordinator.register({ kind: 'manual', id: 'm', workflowId: 'no/such/wf.ts' })
    await coordinator.fire('m')
    expect(coordinator.get('m')?.lastError).toMatch(/workflow not registered/)
    await coordinator.stop()
    await gw.stop()
  })

  it('rejects when the loaded module exports no default pipeline', async () => {
    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
    })
    await gw.start()
    const dispatcher = createTriggerDispatcher({
      gateway: gw,
      loadWorkflow: async () => ({ notDefault: 'oops' }),
    })
    const coordinator = new TriggerCoordinator({ onFire: dispatcher })
    coordinator.register({
      kind: 'manual',
      id: 'm',
      workflowId: 'workflows/hello.workflow.mts',
    })
    await coordinator.fire('m')
    await waitFor(() => coordinator.get('m')?.lastError !== undefined)
    expect(coordinator.get('m')?.lastError).toMatch(/did not export a default pipeline/)
    await coordinator.stop()
    await gw.stop()
  })
})

describe('Gateway — auto-wires the dispatcher when loadWorkflow is supplied', () => {
  it('triggers registered via managers.triggers actually run pipelines', async () => {
    const ran: string[] = []
    const fakePipeline = pipeline({
      id: 'auto-wired',
      steps: [
        code({
          id: 'step',
          run: () => {
            ran.push('ran')
            return {}
          },
        }),
      ],
    })

    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
      loadWorkflow: async (id) => {
        expect(id).toBe('workflows/hello.workflow.mts')
        return { default: fakePipeline }
      },
    })
    await gw.start()

    gw.managers.triggers.register({
      kind: 'manual',
      id: 'wired',
      workflowId: 'workflows/hello.workflow.mts',
    })
    await gw.managers.triggers.fire('wired')

    await waitFor(() => ran.length === 1)
    expect(ran).toEqual(['ran'])
    await gw.stop()
  })

  it('leaves onFire as a no-op when loadWorkflow is not supplied', async () => {
    const gw = new Gateway({ stateDir, projectRoot, watchRegistries: false })
    await gw.start()

    gw.managers.triggers.register({
      kind: 'manual',
      id: 'unwired',
      workflowId: 'workflows/hello.workflow.mts',
    })
    await gw.managers.triggers.fire('unwired')

    // No-op: trigger fires accounting still happens, but no run is started.
    expect(gw.managers.triggers.get('unwired')?.fired).toBe(1)
    expect(gw.managers.triggers.get('unwired')?.lastError).toBeUndefined()
    await gw.stop()
  })
})
