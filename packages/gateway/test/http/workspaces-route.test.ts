import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore, WorkspaceManager } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

let stateDir: string
let gw: Gateway | undefined
let base: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-ws-route-'))
  const booted = await bootGatewayWithRetry((port) => ({
    stateDir,
    enableHttp: true,
    httpPort: port,
    installSignalHandlers: false,
    runStore: new MemoryRunStore(),
  }))
  gw = booted.gw
  base = booted.base
})

afterEach(async () => {
  await gw?.stop()
  gw = undefined
  await rm(stateDir, { recursive: true, force: true })
})

async function preparePersistent(): Promise<void> {
  const manager = new WorkspaceManager({
    persistentBase: join(stateDir, 'workspaces'),
  })
  const ws = await manager.prepare({
    pipelineId: 'wf-x',
    runId: 'r1',
    workspace: { mode: 'persistent', name: 'main' },
  })
  await ws.finishStep('completed')
  await ws.finishRun('completed')
}

describe('/workspaces', () => {
  it('GET /workspaces returns an empty list with no workspaces', async () => {
    const res = await fetch(`${base}/workspaces`)
    expect(res.status).toBe(200)
    const { workspaces } = await res.json()
    expect(workspaces).toEqual([])
  })

  it('GET /workspaces lists persistent workspaces', async () => {
    await preparePersistent()
    const res = await fetch(`${base}/workspaces`)
    expect(res.status).toBe(200)
    const { workspaces } = await res.json()
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]).toMatchObject({ pipelineId: 'wf-x', name: 'main' })
  })

  it('GET /workspaces/:wf/:name returns metadata; 404 when missing', async () => {
    await preparePersistent()
    const ok = await fetch(`${base}/workspaces/wf-x/main`)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ pipelineId: 'wf-x', name: 'main' })

    const missing = await fetch(`${base}/workspaces/wf-x/does-not-exist`)
    expect(missing.status).toBe(404)
  })

  it('DELETE /workspaces/:wf/:name cleans a workspace', async () => {
    await preparePersistent()
    const del = await fetch(`${base}/workspaces/wf-x/main`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await del.json()).toMatchObject({ cleaned: 'wf-x/main' })

    const after = await fetch(`${base}/workspaces`)
    expect((await after.json()).workspaces).toEqual([])
  })
})
