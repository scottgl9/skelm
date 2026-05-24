import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../../src/index.js'
import { pickFreePort } from '../utils/pick-free-port.js'

let stateDir: string
let gw: Gateway | undefined
let base: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-secrets-route-'))
  const port = await pickFreePort()
  gw = new Gateway({
    stateDir,
    enableHttp: true,
    httpPort: port,
    installSignalHandlers: false,
    runStore: new MemoryRunStore(),
    config: { secrets: { driver: 'file' } },
  })
  await gw.start()
  base = `http://127.0.0.1:${port}`
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

  it('PUT /secrets/:name persists; GET /secrets/:name returns plaintext', async () => {
    const put = await fetch(`${base}/secrets/TEST_KEY`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 's3cret' }),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ stored: 'TEST_KEY' })

    const list = await fetch(`${base}/secrets`)
    expect((await list.json()).names).toContain('TEST_KEY')

    const get = await fetch(`${base}/secrets/TEST_KEY`)
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual({ name: 'TEST_KEY', value: 's3cret' })
  })

  it('GET /secrets/:name returns 404 for an unknown name', async () => {
    const res = await fetch(`${base}/secrets/missing`)
    expect(res.status).toBe(404)
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
