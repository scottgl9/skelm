import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore, code, pipeline } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../../src/index.js'
import { pickFreePort } from '../utils/pick-free-port.js'

let stateDir: string
let projectRoot: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-wfreg-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-wfreg-root-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

const goodPipeline = pipeline({
  id: 'echo',
  steps: [code({ id: 'one', run: () => ({ ok: true }) })],
})

async function bootGateway(opts: { allowedDirs?: string[] } = {}): Promise<{
  gw: Gateway
  base: string
}> {
  const port = await pickFreePort()
  const gw = new Gateway({
    stateDir,
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    runStore: new MemoryRunStore(),
    loadWorkflow: async () => goodPipeline,
    ...(opts.allowedDirs !== undefined && { allowedRegistrationDirs: opts.allowedDirs }),
    config: {
      registries: { workflows: { glob: 'workflows/**/*.workflow.ts' } },
    },
  })
  await gw.start()
  return { gw, base: `http://127.0.0.1:${port}` }
}

describe('/v1/workflows/*', () => {
  it('POST /v1/workflows/validate compiles and returns the pipeline graph', async () => {
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    const wfPath = join(projectRoot, 'workflows/a.workflow.ts')
    await fs.writeFile(wfPath, 'export default {}')
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/workflows/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: { type: 'path', path: wfPath } }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.valid).toBe(true)
      expect(body.pipeline.id).toBe('echo')
      expect(body.pipeline.graph.steps).toHaveLength(1)
    } finally {
      await gw.stop()
    }
  })

  it('POST /v1/workflows/register persists and exposes workflow via /pipelines', async () => {
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    const wfPath = join(projectRoot, 'workflows/a.workflow.ts')
    await fs.writeFile(wfPath, 'export default {}')
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/workflows/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'my-flow',
          source: { type: 'path', path: wfPath },
          version: '1.0.0',
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.registered).toBe(true)
      expect(body.workflow.id).toBe('my-flow')
      expect(body.workflow.version).toBe('1.0.0')

      const list = await fetch(`${base}/pipelines`).then((r) => r.json())
      expect(list.some((e: { id: string }) => e.id === 'my-flow')).toBe(true)
    } finally {
      await gw.stop()
    }
  })

  it('rejects paths outside projectRoot (default-deny)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'skelm-outside-'))
    const wfPath = join(outside, 'x.ts')
    await fs.writeFile(wfPath, 'export default {}')
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/workflows/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'outside',
          source: { type: 'path', path: wfPath },
        }),
      })
      expect(res.status).toBe(400)
      // Path was rejected by the service — verify the registration did not take effect.
      const list = await fetch(`${base}/v1/workflows`).then((r) => r.json())
      expect(list.find((e: { id: string }) => e.id === 'outside')).toBeUndefined()
    } finally {
      await gw.stop()
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('honors allowedRegistrationDirs when path is outside projectRoot', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'skelm-allow-'))
    const wfPath = join(outside, 'x.ts')
    await fs.writeFile(wfPath, 'export default {}')
    const { gw, base } = await bootGateway({ allowedDirs: [outside] })
    try {
      const res = await fetch(`${base}/v1/workflows/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'ok', source: { type: 'path', path: wfPath } }),
      })
      expect(res.status).toBe(200)
    } finally {
      await gw.stop()
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects ids with traversal segments', async () => {
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/workflows/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: '../evil',
          source: { type: 'path', path: '/tmp/whatever.ts' },
        }),
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('rejects code-source registration as unsupported', async () => {
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/workflows/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: { type: 'code', code: 'export default {}' } }),
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('PUT /v1/workflows/:id replaces and DELETE /v1/workflows/:id removes', async () => {
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    const a = join(projectRoot, 'workflows/a.ts')
    const b = join(projectRoot, 'workflows/b.ts')
    await fs.writeFile(a, 'export default {}')
    await fs.writeFile(b, 'export default {}')
    const { gw, base } = await bootGateway()
    try {
      await fetch(`${base}/v1/workflows/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'flow', source: { type: 'path', path: a } }),
      })
      const put = await fetch(`${base}/v1/workflows/flow`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: { type: 'path', path: b } }),
      })
      expect(put.status).toBe(200)
      const body = await put.json()
      expect(body.workflow.sourcePath).toBe(b)

      const del = await fetch(`${base}/v1/workflows/flow`, { method: 'DELETE' })
      expect(del.status).toBe(200)
      const after = await fetch(`${base}/v1/workflows`).then((r) => r.json())
      expect(after.find((e: { id: string }) => e.id === 'flow')).toBeUndefined()
    } finally {
      await gw.stop()
    }
  })

  it('replays persisted registrations after gateway restart', async () => {
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    const wfPath = join(projectRoot, 'workflows/a.workflow.ts')
    await fs.writeFile(wfPath, 'export default {}')

    {
      const { gw, base } = await bootGateway()
      try {
        const res = await fetch(`${base}/v1/workflows/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'persist', source: { type: 'path', path: wfPath } }),
        })
        expect(res.status).toBe(200)
      } finally {
        await gw.stop()
      }
    }

    {
      const { gw, base } = await bootGateway()
      try {
        const list = await fetch(`${base}/v1/workflows`).then((r) => r.json())
        expect(list.some((e: { id: string }) => e.id === 'persist')).toBe(true)
      } finally {
        await gw.stop()
      }
    }
  })
})
