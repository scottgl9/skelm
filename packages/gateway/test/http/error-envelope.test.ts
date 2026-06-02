import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

let stateDir: string
let projectRoot: string
let gw: Gateway | undefined
let base: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-err-env-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-err-env-root-'))
  const booted = await bootGatewayWithRetry((port) => ({
    stateDir,
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    runStore: new MemoryRunStore(),
    loadWorkflow: async () => ({}),
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

describe('gateway error envelope', () => {
  it('createError() messages reach the client as JSON', async () => {
    // run-file with missing `file` triggers createError({statusCode: 400, message: ...})
    const res = await fetch(`${base}/pipelines/run-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = (await res.json()) as { message: string; statusCode: number }
    expect(body.statusCode).toBe(400)
    expect(body.message).toMatch(/file/i)
  })

  it('404 paths return JSON body with message', async () => {
    const res = await fetch(`${base}/runs/does-not-exist`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = (await res.json()) as { message: string; statusCode: number }
    expect(body.statusCode).toBe(404)
    expect(typeof body.message).toBe('string')
    expect(body.message.length).toBeGreaterThan(0)
  })

  it('does not include stack when NODE_ENV=production', async () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const res = await fetch(`${base}/pipelines/run-file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { stack?: string }
      expect(body.stack).toBeUndefined()
    } finally {
      // biome-ignore lint/performance/noDelete: env var must be removed, not blanked
      if (prev === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prev
    }
  })
})
