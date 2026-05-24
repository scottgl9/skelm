import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

let stateDir: string
let gw: Gateway | undefined
let base: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-secrets-route-'))
  const booted = await bootGatewayWithRetry((port) => ({
    stateDir,
    enableHttp: true,
    httpPort: port,
    installSignalHandlers: false,
    runStore: new MemoryRunStore(),
    config: { secrets: { driver: 'file' } },
  }))
  gw = booted.gw
  base = booted.base
})

afterEach(async () => {
  await gw?.stop()
  gw = undefined
  await rm(stateDir, { recursive: true, force: true })
})

describe('/secrets', () => {
  it('GET /secrets returns empty names on a clean state dir', async () => {
    const res = await fetch(`${base}/secrets`)
    expect(res.status).toBe(200)
    const { names } = await res.json()
    expect(names).toEqual([])
  })

  it('PUT /secrets/:name persists; GET /secrets/:name returns existence only', async () => {
    const put = await fetch(`${base}/secrets/TEST_KEY`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 's3cret' }),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ stored: 'TEST_KEY' })

    const list = await fetch(`${base}/secrets`)
    expect((await list.json()).names).toContain('TEST_KEY')

    // Deliberately write-only: GET returns set: true with NO value field.
    const get = await fetch(`${base}/secrets/TEST_KEY`)
    expect(get.status).toBe(200)
    const body = await get.json()
    expect(body).toEqual({ name: 'TEST_KEY', set: true })
    expect(body).not.toHaveProperty('value')
  })

  it('GET /secrets/:name returns 404 for an unknown name', async () => {
    const res = await fetch(`${base}/secrets/missing`)
    expect(res.status).toBe(404)
  })

  it('DELETE /secrets/:name actually removes the entry; subsequent list omits it', async () => {
    await fetch(`${base}/secrets/TO_DELETE`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'temp' }),
    })
    expect((await (await fetch(`${base}/secrets`)).json()).names).toContain('TO_DELETE')

    const del = await fetch(`${base}/secrets/TO_DELETE`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ deleted: 'TO_DELETE' })

    // The whole point of the reviewer's bug report: the name must NOT
    // show up afterwards. A second DELETE returns 404.
    expect((await (await fetch(`${base}/secrets`)).json()).names).not.toContain('TO_DELETE')
    expect((await fetch(`${base}/secrets/TO_DELETE`)).status).toBe(404)

    const del2 = await fetch(`${base}/secrets/TO_DELETE`, { method: 'DELETE' })
    expect(del2.status).toBe(404)
  })

  it('plaintext never leaves the gateway: list returns names without values', async () => {
    await fetch(`${base}/secrets/SENSITIVE`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'super-secret-value' }),
    })
    const list = await fetch(`${base}/secrets`)
    const text = await list.text()
    expect(text).toContain('SENSITIVE')
    expect(text).not.toContain('super-secret-value')
  })

  it('PUT /secrets/:name with non-string value returns 400', async () => {
    const res = await fetch(`${base}/secrets/TEST_KEY`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 42 }),
    })
    expect(res.status).toBe(400)
  })
})
