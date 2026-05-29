import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendRegistry, type SkelmBackend, persistentWorkflow } from '@skelm/core'
import {
  type TuiFrontend,
  type TuiFrontendIo,
  TuiIntegration,
  type TuiMessageInput,
} from '@skelm/integrations'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../src/index.js'

// End-to-end through the REAL gateway with the REAL TuiIntegration trigger
// source and a stub backend: a line submitted in the frontend → tui queue
// source → gateway persistent turn → reply rendered back in the frontend. This
// is the path the user drives, minus the model (an echo stub stands in for pi so
// the test needs no model).
//
// Streaming (step.partial → frontend.renderPartial) is covered deterministically
// by the integration unit test (packages/integrations/test/tui.test.ts), which
// drives the source's onEvent hook directly. We don't assert the partial stream
// here because run events are delivered asynchronously relative to the awaited
// final output, which makes the exact ordering racy under full-suite load.
// TODO: #250 stabilize the e2e ordering assertion.

function echoBackend(): SkelmBackend {
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
    async run(request) {
      const prompt = typeof request.prompt === 'string' ? request.prompt : ''
      return { text: `echo:${prompt}` }
    },
  }
}

/** A frontend double that captures render and exposes the bridge io. */
function fakeFrontend() {
  const rendered: string[] = []
  let io: TuiFrontendIo | null = null
  const factory = (bridge: TuiFrontendIo): TuiFrontend => {
    io = bridge
    return {
      render: (reply) => rendered.push(reply),
    }
  }
  return {
    factory,
    rendered,
    submit: (text: string) => io?.submit(text),
  }
}

/** Poll until `cond` holds (or timeout). The persistent turn runs async, so we
 *  wait for an observable result rather than a fixed delay. */
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

let projectRoot: string
let stateDir: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-tui-'))
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-tui-state-'))
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  await fs.writeFile(join(projectRoot, 'workflows/tui.workflow.mts'), 'export default {}')
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

async function bootGateway(backend: SkelmBackend, agentModule: unknown): Promise<Gateway> {
  const registry = new BackendRegistry()
  registry.register(backend)
  const gw = new Gateway({
    stateDir,
    projectRoot,
    watchRegistries: false,
    backends: registry,
    auditWriter: { write: async () => {} },
    config: {
      registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
      defaults: { unrestrictedGrants: ['tui-assistant'] },
    },
    loadWorkflow: async () => agentModule,
  })
  await gw.start()
  return gw
}

function wireTui(gw: Gateway, fe: ReturnType<typeof fakeFrontend>): void {
  const tui = new TuiIntegration({ id: 'tui', name: 'Terminal UI', enabled: true, credentials: {} })
  const source = tui.createTriggerSource({ frontend: fe.factory })
  gw.managers.triggers.registerQueueDriver('tui', source)
  gw.managers.triggers.register({
    kind: 'queue',
    id: 'q',
    workflowId: 'workflows/tui.workflow.mts',
    driver: 'tui',
  })
}

const tuiAgent = persistentWorkflow<TuiMessageInput>({
  id: 'tui-assistant',
  agent: {
    backend: 'echo',
    system: 'You are a terminal assistant.',
    sessionKey: (m) => m.sessionId,
    reply: (text) => ({ reply: text }),
  },
})

describe('tui integration end-to-end (real gateway)', () => {
  it('a submitted line drives a persistent turn and renders the reply in the frontend', async () => {
    const gw = await bootGateway(echoBackend(), { default: tuiAgent })
    const fe = fakeFrontend()
    wireTui(gw, fe)

    fe.submit('hi there')
    await waitFor(() => fe.rendered.length > 0)

    expect(fe.rendered).toEqual(['echo:hi there'])
    await gw.stop()
  })

  it('keeps a durable per-session conversation across submitted lines', async () => {
    const gw = await bootGateway(echoBackend(), { default: tuiAgent })
    const fe = fakeFrontend()
    wireTui(gw, fe)

    fe.submit('first')
    await waitFor(() => fe.rendered.length >= 1)
    fe.submit('second')
    await waitFor(() => fe.rendered.length >= 2)

    expect(fe.rendered).toEqual(['echo:first', 'echo:second'])
    await gw.stop()
  })
})
