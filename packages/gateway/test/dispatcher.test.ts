import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { code, pipeline } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway, TriggerCoordinator, createTriggerDispatcher } from '../src/index.js'

let projectRoot: string
let stateDir: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-disp-'))
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-disp-state-'))
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  await fs.writeFile(join(projectRoot, 'workflows/hello.workflow.ts'), 'export default {}')
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

describe('createTriggerDispatcher', () => {
  it('resolves workflowId via the registry, imports via the loader, and runs it', async () => {
    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.ts' } } },
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
        expect(id).toBe('workflows/hello.workflow.ts')
        return { default: fakePipeline }
      },
    })

    const coordinator = new TriggerCoordinator({ onFire: dispatcher })
    coordinator.register({
      kind: 'manual',
      id: 'm',
      workflowId: 'workflows/hello.workflow.ts',
    })
    await coordinator.fire('m')

    expect(ran).toEqual(['step'])
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
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.ts' } } },
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
      workflowId: 'workflows/hello.workflow.ts',
    })
    await coordinator.fire('m')
    expect(coordinator.get('m')?.lastError).toMatch(/did not export a default pipeline/)
    await coordinator.stop()
    await gw.stop()
  })
})
