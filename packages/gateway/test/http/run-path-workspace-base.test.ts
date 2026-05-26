import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

// Regression: a gateway run that declares a PERSISTENT workspace must create
// it under the gateway's stateDir-scoped base (`<stateDir>/workspaces`) — the
// same base the /workspaces list/show/clean routes read from. Before the fix
// the HTTP run paths built the Runner with no workspaceManager, so the runtime
// fell back to its own default base (~/.skelm/workspaces). Under a non-default
// gateway stateDir that diverged from where /workspaces looks, so a workspace
// a run created was invisible to `skelm workspace list/show/clean`.

const PERSISTENT_WS_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/persistent-workspace.workflow.mts',
)

let stateDir: string
let projectRoot: string
let gw: Gateway | undefined
let base: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-ws-base-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-ws-base-root-'))
  const booted = await bootGatewayWithRetry((port) => ({
    stateDir,
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    installSignalHandlers: false,
    loadWorkflow: async (_id, absolutePath) => import(pathToFileURL(absolutePath).href),
  }))
  gw = booted.gw
  base = booted.base
})

afterEach(async () => {
  await gw?.stop()
  gw = undefined
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

describe('run-path persistent workspace base', () => {
  it('creates the workspace under <stateDir>/workspaces (not the runner default)', async () => {
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: PERSISTENT_WS_FIXTURE, input: {} }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('completed')
    // The workspace handle the runtime exposed must live under the gateway's
    // stateDir, proving the run path used the stateDir-scoped WorkspaceManager.
    expect(body.output?.workspacePath).toContain(join(stateDir, 'workspaces'))
  })

  it('makes a run-created persistent workspace visible to GET /workspaces', async () => {
    const run = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: PERSISTENT_WS_FIXTURE, input: {} }),
    })
    expect(run.status).toBe(200)
    expect((await run.json()).status).toBe('completed')

    // Before the fix this returned [] because the run created the workspace
    // under ~/.skelm/workspaces while the route reads <stateDir>/workspaces.
    const list = await fetch(`${base}/workspaces`)
    expect(list.status).toBe(200)
    const { workspaces } = await list.json()
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]).toMatchObject({ pipelineId: 'persistent-workspace', name: 'main' })

    // And the show route resolves it too.
    const show = await fetch(`${base}/workspaces/persistent-workspace/main`)
    expect(show.status).toBe(200)
    expect(await show.json()).toMatchObject({ pipelineId: 'persistent-workspace', name: 'main' })
  })
})
