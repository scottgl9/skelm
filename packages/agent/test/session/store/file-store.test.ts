import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileSessionStore, type SerializedSession } from '../../../src/index.js'

const sample = (n: number): SerializedSession => ({
  version: 1,
  messages: [{ role: 'user', content: `m${n}` }],
})

describe('FileSessionStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skelm-agent-store-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('save + load round-trips through disk', async () => {
    const s = new FileSessionStore(dir)
    await s.save('alpha', sample(1))
    const loaded = await s.load('alpha')
    expect(loaded).toEqual(sample(1))
  })

  it('load returns undefined when the file is missing', async () => {
    const s = new FileSessionStore(dir)
    expect(await s.load('absent')).toBeUndefined()
  })

  it('list returns all stored ids without the .json suffix', async () => {
    const s = new FileSessionStore(dir)
    await s.save('a', sample(1))
    await s.save('b', sample(2))
    expect((await s.list()).sort()).toEqual(['a', 'b'])
  })

  it('list returns [] when the directory does not exist yet', async () => {
    const s = new FileSessionStore(join(dir, 'nope'))
    expect(await s.list()).toEqual([])
  })

  it('delete returns true on hit, false on miss', async () => {
    const s = new FileSessionStore(dir)
    await s.save('a', sample(1))
    expect(await s.delete('a')).toBe(true)
    expect(await s.delete('a')).toBe(false)
  })

  it('rejects ids with path separators or leading dots', async () => {
    const s = new FileSessionStore(dir)
    await expect(s.save('../escape', sample(1))).rejects.toThrow(/invalid session id/)
    await expect(s.save('a/b', sample(1))).rejects.toThrow(/invalid session id/)
    await expect(s.save('.hidden', sample(1))).rejects.toThrow(/invalid session id/)
  })
})
