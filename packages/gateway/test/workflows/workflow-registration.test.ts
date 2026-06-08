import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore, type Run, type RunStatus, code, pipeline } from '@skelm/core'
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

async function bootGateway(
  opts: {
    allowedDirs?: string[]
    auth?: boolean
    loadWorkflow?: (registryId: string, absolutePath: string) => Promise<unknown>
  } = {},
): Promise<{
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
    loadWorkflow: opts.loadWorkflow ?? (async () => goodPipeline),
    ...(opts.allowedDirs !== undefined && { allowedRegistrationDirs: opts.allowedDirs }),
    ...(opts.auth === true && { token: 'sekret' }),
    config: {
      ...(opts.auth === true && {
        server: { host: '127.0.0.1', port, auth: { mode: 'bearer' as const } },
      }),
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

  it('POST /v1/workflows/register accepts inline JSON workflow definitions', async () => {
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/workflows/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'inline-flow',
          description: 'inline fixture',
          steps: [{ kind: 'code', id: 'hello', run: 'async () => ({ ok: true })' }],
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.registered).toBe(true)
      expect(body.workflow.id).toBe('inline-flow')
      expect(body.workflow.sourceKind).toBe('archive')

      const list = await fetch(`${base}/v1/workflows`).then((r) => r.json())
      expect(list.some((e: { id: string }) => e.id === 'inline-flow')).toBe(true)
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

  it('GET /v1/workflows/health reports workflow runs, active runs, triggers, and failures', async () => {
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    const wfPath = join(projectRoot, 'workflows/a.workflow.ts')
    await fs.writeFile(wfPath, 'export default {}')
    const { gw, base } = await bootGateway()
    try {
      await gw.runStore.putRun(
        makeRun({
          runId: 'done',
          pipelineId: 'workflows/a.workflow.ts',
          workflowPath: wfPath,
          status: 'completed',
        }),
      )
      await gw.runStore.putRun(
        makeRun({
          runId: 'bad',
          pipelineId: 'echo',
          workflowPath: wfPath,
          status: 'failed',
          error: { name: 'Error', message: 'boom' },
        }),
      )
      await gw.runStore.putRun(
        makeRun({
          runId: 'live',
          pipelineId: 'workflows/a.workflow.ts',
          workflowPath: wfPath,
          triggerId: 'manual-a',
          status: 'running',
          completedAt: undefined,
        }),
      )
      gw.managers.triggers.register({
        kind: 'manual',
        id: 'manual-a',
        workflowId: 'workflows/a.workflow.ts',
      })

      const res = await fetch(`${base}/v1/workflows/health`)
      expect(res.status).toBe(200)
      const body = await res.json()
      const workflow = body.workflows.find(
        (entry: { id: string }) => entry.id === 'workflows/a.workflow.ts',
      )
      expect(workflow.pipelineId).toBe('echo')
      expect(workflow.runs.total).toBe(3)
      expect(workflow.runs.byStatus.completed).toBe(1)
      expect(workflow.runs.byStatus.failed).toBe(1)
      expect(workflow.runs.active).toBe(1)
      expect(workflow.runs.recentFailures[0].message).toBe('boom')
      expect(workflow.activeRuns[0].runId).toBe('live')
      expect(workflow.triggers[0]).toMatchObject({
        id: 'manual-a',
        kind: 'manual',
        queueDepth: 0,
        runningCount: 0,
      })
      expect(workflow.readiness.status).toBe('degraded')
    } finally {
      await gw.stop()
    }
  })

  it('GET /v1/workflows/:id/health returns one workflow health record', async () => {
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    const wfPath = join(projectRoot, 'workflows/detail.workflow.ts')
    await fs.writeFile(wfPath, 'export default {}')
    const { gw, base } = await bootGateway()
    try {
      const id = encodeURIComponent('workflows/detail.workflow.ts')
      const res = await fetch(`${base}/v1/workflows/${id}/health`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.workflow.id).toBe('workflows/detail.workflow.ts')
      expect(body.workflow.readiness.ready).toBe(true)
    } finally {
      await gw.stop()
    }
  })

  it('GET /v1/workflows/health rejects a bad recentFailuresLimit query', async () => {
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/workflows/health?recentFailuresLimit=nope`)
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('GET /v1/workflows/health keeps broken workflow load failures isolated', async () => {
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    const goodPath = join(projectRoot, 'workflows/good.workflow.ts')
    const brokenPath = join(projectRoot, 'workflows/broken.workflow.ts')
    await fs.writeFile(goodPath, 'export default {}')
    await fs.writeFile(brokenPath, 'export default {}')
    const { gw, base } = await bootGateway({
      loadWorkflow: async (_id, path) => {
        if (path === brokenPath) throw new Error('broken import')
        return goodPipeline
      },
    })
    try {
      const res = await fetch(`${base}/v1/workflows/health`)
      expect(res.status).toBe(200)
      const body = await res.json()
      const byId = new Map(body.workflows.map((entry: { id: string }) => [entry.id, entry]))
      expect(
        (byId.get('workflows/good.workflow.ts') as { readiness: { status: string } }).readiness
          .status,
      ).toBe('ready')
      expect(
        (byId.get('workflows/broken.workflow.ts') as { readiness: { status: string } }).readiness
          .status,
      ).toBe('broken')
    } finally {
      await gw.stop()
    }
  })

  it('GET /v1/workflows/health requires bearer auth when configured', async () => {
    const { gw, base } = await bootGateway({ auth: true })
    try {
      const unauth = await fetch(`${base}/v1/workflows/health`)
      expect(unauth.status).toBe(401)

      const authed = await fetch(`${base}/v1/workflows/health`, {
        headers: { authorization: 'Bearer sekret' },
      })
      expect(authed.status).toBe(200)
    } finally {
      await gw.stop()
    }
  })
})

function makeRun(o: {
  runId: string
  pipelineId: string
  workflowPath?: string
  triggerId?: string
  status?: RunStatus
  error?: { name: string; message: string }
  completedAt?: number
}): Run {
  const startedAt = Date.now() - 1_000
  return {
    runId: o.runId,
    pipelineId: o.pipelineId,
    ...(o.workflowPath !== undefined && { workflowPath: o.workflowPath }),
    ...(o.triggerId !== undefined && { triggerId: o.triggerId }),
    status: o.status ?? 'completed',
    input: {},
    steps: [],
    output: undefined,
    error: o.error ?? undefined,
    startedAt,
    completedAt: o.completedAt ?? (o.status === 'running' ? undefined : startedAt + 500),
  }
}
