import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bootGatewayWithRetry } from './utils/boot-gateway.js'

// Real gateway, real WorkflowRegistrationService path-gate, real config import:
// exercises POST /v1/projects/activate end to end. The security-critical claim
// is that a dir outside the trusted roots is refused BEFORE its config is
// imported, so no grant goes live and nothing is armed.
//
// The trusted project lives UNDER the package dir, not in the OS tmp dir: the
// gateway imports its config with a bare `@skelm/core` specifier, which under
// vitest's vite-node loader only resolves when the file sits inside the repo's
// node_modules reach. (Production runs under plain Node, where /tmp resolves
// fine — this is purely a test-loader constraint.) The untrusted dir stays in
// the OS tmp dir; it is refused before any import, so resolution never matters.

const TEST_DIR = dirname(fileURLToPath(import.meta.url))

let projectRoot: string
let outsideRoot: string

const CONFIG_MTS = `import { defineConfig } from '@skelm/core'

const memSource = {
  start() {},
  stop() {},
}

const echoBackend = {
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
  async run() {
    return { text: 'echo' }
  },
}

export default defineConfig({
  registries: { workflows: { glob: '*.workflow.mts' } },
  instances: [echoBackend],
  triggerSources: [{ id: 'mem', driver: memSource }],
  defaults: { unrestrictedGrants: ['echo-assistant'] },
})
`

const WORKFLOW_MTS = `import { persistentWorkflow } from '@skelm/core'

export default persistentWorkflow({
  id: 'echo-assistant',
  triggers: [{ kind: 'queue', sourceId: 'mem' }],
  agent: {
    backend: 'echo',
    sessionKey: (m) => (m && m.sessionId) || 'default',
    permissions: { requestUnrestricted: true },
  },
})
`

async function writeProject(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'skelm.config.mts'), CONFIG_MTS, 'utf8')
  await writeFile(join(dir, 'echo.workflow.mts'), WORKFLOW_MTS, 'utf8')
}

beforeEach(async () => {
  projectRoot = await mkdtemp(join(TEST_DIR, '.tmp-activate-root-'))
  outsideRoot = await mkdtemp(join(tmpdir(), 'skelm-activate-outside-'))
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await rm(outsideRoot, { recursive: true, force: true })
})

async function boot() {
  return bootGatewayWithRetry((port) => ({
    stateDir: join(tmpdir(), `skelm-activate-state-${port}`),
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
  }))
}

describe('POST /v1/projects/activate', () => {
  it('activates a trusted project: arms the queue trigger, absorbs the backend, and makes the grant live', async () => {
    const proj = join(projectRoot, 'proj')
    await writeProject(proj)
    const { gw, base } = await boot()
    try {
      const res = await fetch(`${base}/v1/projects/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: proj }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.trusted).toBe(true)
      expect(body.refresh).toBe(false)
      expect(body.workflows).toEqual([
        expect.objectContaining({ id: 'echo-assistant', kind: 'persistent-workflow' }),
      ])
      expect(body.triggers).toEqual([
        expect.objectContaining({ kind: 'queue', driver: 'mem', armed: true }),
      ])
      expect(body.backends.absorbed).toContain('echo')
      expect(body.grants.absorbed).toEqual(['echo-assistant'])

      // The grant is now LIVE — it came from the merge, not author input.
      expect(gw.isUnrestrictedGranted('echo-assistant')).toBe(true)
      // The queue trigger is armed on the coordinator.
      const armed = gw.managers.triggers
        .list()
        .filter((r) => r.spec.workflowId === 'echo-assistant')
      expect(armed).toHaveLength(1)

      // Re-activating the same dir is an idempotent refresh.
      const again = await fetch(`${base}/v1/projects/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: proj }),
      }).then((r) => r.json())
      expect(again.refresh).toBe(true)
      expect(
        gw.managers.triggers.list().filter((r) => r.spec.workflowId === 'echo-assistant'),
      ).toHaveLength(1)
    } finally {
      await gw.stop()
    }
  })

  it('refuses an out-of-tree dir wholesale: no grant goes live, nothing is armed', async () => {
    const proj = join(outsideRoot, 'proj')
    await writeProject(proj)
    const { gw, base } = await boot()
    try {
      const res = await fetch(`${base}/v1/projects/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: proj }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()

      expect(body.trusted).toBe(false)
      expect(body.workflows).toEqual([])
      expect(body.triggers).toEqual([])
      expect(body.grants.absorbed).toEqual([])
      expect(typeof body.message).toBe('string')

      // SECURITY: the untrusted config never escalated anything.
      expect(gw.isUnrestrictedGranted('echo-assistant')).toBe(false)
      expect(gw.managers.triggers.list()).toEqual([])
    } finally {
      await gw.stop()
    }
  })

  it('400 when dir is missing, 400 when no config, 404 when dir does not exist', async () => {
    const { gw, base } = await boot()
    try {
      const noDir = await fetch(`${base}/v1/projects/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(noDir.status).toBe(400)

      const emptyProj = join(projectRoot, 'empty')
      await mkdir(emptyProj, { recursive: true })
      const noConfig = await fetch(`${base}/v1/projects/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: emptyProj }),
      })
      expect(noConfig.status).toBe(400)

      const missing = await fetch(`${base}/v1/projects/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: join(projectRoot, 'nope') }),
      })
      expect(missing.status).toBe(404)
    } finally {
      await gw.stop()
    }
  })
})
