import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MemoryRunStore } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

// Reuse the cli package's fixture workflow — it sits inside the monorepo so
// `@skelm/core` resolves via workspace symlinks, which is what real users see.
const HELLO_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../cli/test/fixtures/hello.workflow.mts',
)
// A workflow that parks at wait() with no timeout — drives the resume path.
const WAIT_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../cli/test/fixtures/wait.workflow.mts',
)

let stateDir: string
let projectRoot: string
let gw: Gateway | undefined
let base: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-runfile-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-runfile-root-'))
  const booted = await bootGatewayWithRetry((port) => ({
    stateDir,
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    runStore: new MemoryRunStore(),
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

describe('POST /pipelines/run-file', () => {
  it('runs an ad-hoc workflow file to completion', async () => {
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: HELLO_FIXTURE, input: { name: 'world' } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('completed')
    expect(body.runId).toMatch(/[a-f0-9-]{36}/)
    expect(body.output).toEqual({ greeting: 'hello, world' })
  })

  it('rejects a relative path with 400', async () => {
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'relative/path.pipeline.ts' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects an empty file field with 400', async () => {
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a missing file with 404', async () => {
    const missing = join(projectRoot, 'does-not-exist.pipeline.ts')
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: missing }),
    })
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({
      message: expect.stringContaining(missing),
    })
  })

  it('rejects a path with traversal segments with 400', async () => {
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: `${projectRoot}/../escape.pipeline.ts` }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects an unsupported extension with 400', async () => {
    const path = join(projectRoot, 'not-a-pipeline.txt')
    await fs.writeFile(path, 'hello')
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: path }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 422 when the file has no default pipeline export', async () => {
    const path = join(projectRoot, 'nodefault.pipeline.mts')
    await fs.writeFile(path, 'export const named = 1')
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: path }),
    })
    expect(res.status).toBe(422)
  })
})

describe('POST /runs', () => {
  it('starts an ad-hoc run by pipelinePath and returns runId immediately', async () => {
    const startRes = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pipelinePath: HELLO_FIXTURE, input: { name: 'runs' } }),
    })
    expect(startRes.status).toBe(200)
    const { runId, status, pipelineId } = await startRes.json()
    expect(status).toBe('running')
    expect(runId).toMatch(/[a-f0-9-]{36}/)
    expect(pipelineId).toBe('hello-fixture')

    const deadline = Date.now() + 5_000
    let finalState: { status?: string; output?: unknown } | null = null
    while (Date.now() < deadline) {
      const r = await fetch(`${base}/runs/${runId}`)
      if (r.ok) {
        finalState = await r.json()
        if (finalState?.status === 'completed' || finalState?.status === 'failed') break
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(finalState?.status).toBe('completed')
    expect(finalState?.output).toEqual({ greeting: 'hello, runs' })
  })

  it('parks at wait() then resumes to completion via POST /runs/:id/resume with {input}', async () => {
    const startRes = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pipelinePath: WAIT_FIXTURE, input: {} }),
    })
    expect(startRes.status).toBe(200)
    const { runId } = await startRes.json()

    // Poll until the run parks at the wait() step.
    const waitDeadline = Date.now() + 5_000
    let parked = false
    while (Date.now() < waitDeadline) {
      const r = await fetch(`${base}/runs/${runId}`)
      if (r.ok) {
        const state = await r.json()
        if (state?.waiting !== undefined) {
          parked = true
          break
        }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(parked).toBe(true)

    // Resume using the `input` alias (not the documented `output` field).
    const resumeRes = await fetch(`${base}/runs/${runId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { approved: true } }),
    })
    expect(resumeRes.status).toBe(200)
    expect((await resumeRes.json()).resumed).toBe(true)

    const deadline = Date.now() + 5_000
    let finalState: { status?: string; output?: unknown } | null = null
    while (Date.now() < deadline) {
      const r = await fetch(`${base}/runs/${runId}`)
      if (r.ok) {
        finalState = await r.json()
        if (finalState?.status === 'completed' || finalState?.status === 'failed') break
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(finalState?.status).toBe('completed')
    expect(finalState?.output).toEqual({ approved: true })
  })

  it('rejects a relative pipelinePath with 400', async () => {
    const res = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pipelinePath: 'relative/path.pipeline.ts' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a missing pipelinePath with 404', async () => {
    const res = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pipelinePath: join(projectRoot, 'nope.pipeline.ts') }),
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /pipelines/start-file', () => {
  it('returns runId immediately and the run completes in the background', async () => {
    const startRes = await fetch(`${base}/pipelines/start-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: HELLO_FIXTURE, input: { name: 'async' } }),
    })
    expect(startRes.status).toBe(200)
    const { runId, status, pipelineId } = await startRes.json()
    expect(status).toBe('running')
    expect(runId).toMatch(/[a-f0-9-]{36}/)
    // pipelineId now surfaces the workflow's declared id (so the CLI can
    // render '> running <id>'), not the cli:<sha> registry-tracking id.
    expect(pipelineId).toBe('hello-fixture')

    const deadline = Date.now() + 5_000
    let finalState: { status?: string; output?: unknown } | null = null
    while (Date.now() < deadline) {
      const r = await fetch(`${base}/runs/${runId}`)
      if (r.ok) {
        finalState = await r.json()
        if (finalState?.status === 'completed' || finalState?.status === 'failed') break
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(finalState?.status).toBe('completed')
    expect(finalState?.output).toEqual({ greeting: 'hello, async' })
  })

  it('applies defaults from configPath when provided', async () => {
    const configFile = join(stateDir, 'skelm.config.mjs')
    await fs.writeFile(
      configFile,
      'export default { defaults: { permissions: { allowedExecutables: ["node"] } } }',
    )
    const startRes = await fetch(`${base}/pipelines/start-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: HELLO_FIXTURE, input: { name: 'cfg' }, configPath: configFile }),
    })
    expect(startRes.status).toBe(200)
    const { runId } = await startRes.json()
    const deadline = Date.now() + 5_000
    let finalState: { status?: string; output?: unknown } | null = null
    while (Date.now() < deadline) {
      const r = await fetch(`${base}/runs/${runId}`)
      if (r.ok) {
        finalState = await r.json()
        if (finalState?.status === 'completed' || finalState?.status === 'failed') break
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(finalState?.status).toBe('completed')
    expect(finalState?.output).toEqual({ greeting: 'hello, cfg' })
  })

  it('falls back to gateway defaults when configPath does not exist', async () => {
    const startRes = await fetch(`${base}/pipelines/start-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: HELLO_FIXTURE,
        input: { name: 'fallback' },
        configPath: join(stateDir, 'nonexistent.config.mjs'),
      }),
    })
    expect(startRes.status).toBe(200)
    const { runId } = await startRes.json()
    const deadline = Date.now() + 5_000
    let finalState: { status?: string; output?: unknown } | null = null
    while (Date.now() < deadline) {
      const r = await fetch(`${base}/runs/${runId}`)
      if (r.ok) {
        finalState = await r.json()
        if (finalState?.status === 'completed' || finalState?.status === 'failed') break
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(finalState?.status).toBe('completed')
    expect(finalState?.output).toEqual({ greeting: 'hello, fallback' })
  })
})
