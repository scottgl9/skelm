import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore, code, pipeline } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

let stateDir: string
let projectRoot: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-batch-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-batch-root-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

const wf = pipeline({
  id: 'b',
  steps: [code({ id: 'one', run: () => ({ ok: true }) })],
})

async function bootGateway(
  overrides: { batch?: { maxItemsPerRequest?: number } } = {},
): Promise<{ gw: Gateway; base: string }> {
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  await fs.writeFile(join(projectRoot, 'workflows/a.workflow.ts'), 'export default {}')
  await fs.writeFile(join(projectRoot, 'workflows/b.workflow.ts'), 'export default {}')
  return bootGatewayWithRetry((port) => ({
    stateDir,
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    runStore: new MemoryRunStore(),
    loadWorkflow: async () => wf,
    config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
    ...(overrides.batch !== undefined && { batch: overrides.batch }),
  }))
}

describe('/v1/batch/*', () => {
  it('POST /v1/batch/runs fans out and reports per-item runIds', async () => {
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/batch/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ id: 'workflows/a.workflow.ts' }, { id: 'workflows/b.workflow.ts' }],
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items).toHaveLength(2)
      expect(body.items[0].accepted).toBe(true)
      expect(body.items[0].runId).toMatch(/[a-f0-9-]{36}/)
      expect(body.items[0].description).toBe('started')
      expect(body.items[1].accepted).toBe(true)
      expect(body.items[1].description).toBe('started')
    } finally {
      await gw.stop()
    }
  })

  it('per-item errors do not fail the batch', async () => {
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/batch/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ id: 'workflows/a.workflow.ts' }, { id: 'does-not-exist' }],
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items[0].accepted).toBe(true)
      expect(body.items[1].accepted).toBe(false)
      expect(body.items[1].error).toBeTruthy()
      expect(body.items[1].description).toBe('workflow-not-found')
    } finally {
      await gw.stop()
    }
  })

  it('rejects batches above the 50-item cap', async () => {
    const { gw, base } = await bootGateway()
    try {
      const items = Array.from({ length: 51 }, () => ({ id: 'workflows/a.workflow.ts' }))
      const res = await fetch(`${base}/v1/batch/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('honours a configured smaller batch cap', async () => {
    const { gw, base } = await bootGateway({ batch: { maxItemsPerRequest: 2 } })
    try {
      const items = Array.from({ length: 3 }, () => ({ id: 'workflows/a.workflow.ts' }))
      const res = await fetch(`${base}/v1/batch/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('/v1/batch/cancel reports per-id outcome', async () => {
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/batch/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runIds: ['never-existed'] }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items[0]).toEqual({
        runId: 'never-existed',
        cancelled: false,
        error: 'not in flight',
      })
    } finally {
      await gw.stop()
    }
  })
})
