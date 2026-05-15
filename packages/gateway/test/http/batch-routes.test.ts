import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore, code, pipeline } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../../src/index.js'

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
  const port = await pickFreePort()
  const gw = new Gateway({
    stateDir,
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    runStore: new MemoryRunStore(),
    loadWorkflow: async () => wf,
    config: { registries: { workflows: { glob: 'workflows/**/*.workflow.ts' } } },
    ...(overrides.batch !== undefined && { batch: overrides.batch }),
  })
  await gw.start()
  return { gw, base: `http://127.0.0.1:${port}` }
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

async function pickFreePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close()
        reject(new Error('port pick failed'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}
