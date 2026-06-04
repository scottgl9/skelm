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
const rmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 25 } as const

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-wfreg-'))
  stateDir = await fs.realpath(stateDir)
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-wfreg-root-'))
  projectRoot = await fs.realpath(projectRoot)
})

afterEach(async () => {
  await rm(stateDir, rmOptions)
  await rm(projectRoot, rmOptions)
})

const goodPipeline = pipeline({
  id: 'echo',
  steps: [code({ id: 'one', run: () => ({ ok: true }) })],
})

async function bootGateway(opts: { allowedDirs?: string[] } = {}): Promise<{
  gw: Gateway
  base: string
}> {
  return await bootGatewayWithRetry(async (port) => ({
    stateDir,
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    runStore: new MemoryRunStore(),
    loadWorkflow: async () => goodPipeline,
    ...(opts.allowedDirs !== undefined && { allowedRegistrationDirs: opts.allowedDirs }),
    config: {
      registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
    },
  }))
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
      await rm(outside, rmOptions)
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
      await rm(outside, rmOptions)
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

  it('GET /v1/workflows surfaces glob-discovered workflows and tags by source', async () => {
    // Regression for F023: GET /v1/workflows used to return only the
    // explicitly-registered set (empty by default), while /pipelines
    // returned the full glob discovery. Both should now agree on the
    // union, with a `source` discriminator per entry.
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    const globPath = join(projectRoot, 'workflows/by-glob.workflow.ts')
    await fs.writeFile(globPath, 'export default {}')

    const explicitPath = join(projectRoot, 'workflows/by-register.workflow.ts')
    await fs.writeFile(explicitPath, 'export default {}')

    const { gw, base } = await bootGateway()
    try {
      // Register one of the two explicitly; the other is glob-only.
      const reg = await fetch(`${base}/v1/workflows/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'registered-flow',
          source: { type: 'path', path: explicitPath },
        }),
      })
      expect(reg.status).toBe(200)

      const list = (await fetch(`${base}/v1/workflows`).then((r) => r.json())) as Array<{
        id: string
        source: 'glob' | 'registered'
      }>

      const byId = new Map(list.map((e) => [e.id, e]))
      const globEntry = byId.get('workflows/by-glob.workflow.ts')
      const registered = byId.get('registered-flow')

      expect(globEntry).toBeDefined()
      expect(globEntry?.source).toBe('glob')
      expect(registered).toBeDefined()
      expect(registered?.source).toBe('registered')

      // Sanity-check: /pipelines and /v1/workflows now agree on size.
      const pipelines = (await fetch(`${base}/pipelines`).then((r) => r.json())) as unknown[]
      expect(list.length).toBe(pipelines.length)
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
