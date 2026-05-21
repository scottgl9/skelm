import { promises as fs } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileSecretResolver } from '../../src/secrets/file-driver.js'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skelm-secret-driver-'))
  path = join(dir, 'secrets.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('FileSecretResolver — atomic + serialized writes', () => {
  it('persists a single set/get round-trip', async () => {
    const r = new FileSecretResolver(path)
    await r.set('K', 'value')
    expect(await r.resolve('K')).toBe('value')
  })

  it('serializes concurrent set() calls so no write is lost', async () => {
    const r = new FileSecretResolver(path)
    const N = 50
    await Promise.all(Array.from({ length: N }, (_, i) => r.set(`k${i}`, `v${i}`)))
    const keys = await r.list()
    expect(keys).toHaveLength(N)
    for (let i = 0; i < N; i++) {
      expect(await r.resolve(`k${i}`)).toBe(`v${i}`)
    }
  })

  it('serializes interleaved set + unset operations', async () => {
    const r = new FileSecretResolver(path)
    await r.set('keep', 'yes')
    const ops: Promise<unknown>[] = []
    for (let i = 0; i < 30; i++) ops.push(r.set(`a${i}`, String(i)))
    for (let i = 0; i < 15; i++) ops.push(r.unset(`a${i}`))
    await Promise.all(ops)
    const remaining = await r.list()
    // Ordering of set/unset for the same key is determined by the queue
    // order; the only guarantee here is the final state is internally
    // consistent (no partially-written file, no lost 'keep' key).
    expect(remaining).toContain('keep')
    expect(await r.resolve('keep')).toBe('yes')
  })

  it('writes are atomic — no .tmp leftovers after success', async () => {
    const r = new FileSecretResolver(path)
    await Promise.all(Array.from({ length: 10 }, (_, i) => r.set(`k${i}`, 'v')))
    const entries = await readdir(dir)
    expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0)
    expect(entries).toContain('secrets.json')
  })

  it('uses mode 0600 on the secrets file', async () => {
    const r = new FileSecretResolver(path)
    await r.set('K', 'v')
    const st = await fs.stat(path)
    // Mask the file-type bits; the permission bits should be 0600.
    expect(st.mode & 0o777).toBe(0o600)
  })

  it('returns false from unset() for a missing key', async () => {
    const r = new FileSecretResolver(path)
    expect(await r.unset('never-set')).toBe(false)
  })
})
