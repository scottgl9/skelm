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
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: join(projectRoot, 'does-not-exist.pipeline.ts') }),
    })
    expect(res.status).toBe(404)
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
})
