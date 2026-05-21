import { describe, expect, it } from 'vitest'

import { InMemorySessionStore } from '../../../src/index.js'
import type { SerializedSession } from '../../../src/index.js'

const sample = (n: number): SerializedSession => ({
  version: 1,
  messages: [{ role: 'user', content: `m${n}` }],
})

describe('InMemorySessionStore', () => {
  it('save + load round-trips', async () => {
    const s = new InMemorySessionStore()
    await s.save('a', sample(1))
    const loaded = await s.load('a')
    expect(loaded).toEqual(sample(1))
  })

  it('load() returns undefined for unknown ids', async () => {
    const s = new InMemorySessionStore()
    expect(await s.load('missing')).toBeUndefined()
  })

  it('list() returns all ids', async () => {
    const s = new InMemorySessionStore()
    await s.save('a', sample(1))
    await s.save('b', sample(2))
    expect((await s.list()).sort()).toEqual(['a', 'b'])
  })

  it('delete() removes and returns true on hit, false on miss', async () => {
    const s = new InMemorySessionStore()
    await s.save('a', sample(1))
    expect(await s.delete('a')).toBe(true)
    expect(await s.load('a')).toBeUndefined()
    expect(await s.delete('a')).toBe(false)
  })

  it('save() takes a deep copy — caller mutation does not leak', async () => {
    const s = new InMemorySessionStore()
    const ses = sample(1)
    await s.save('a', ses)
    const first = ses.messages[0] as { content: string }
    first.content = 'mutated'
    const loaded = await s.load('a')
    expect(loaded?.messages[0]?.content).toBe('m1')
  })

  it('load() returns a copy — mutating the loaded value does not affect the store', async () => {
    const s = new InMemorySessionStore()
    await s.save('a', sample(1))
    const loadedOnce = await s.load('a')
    if (loadedOnce === undefined) throw new Error('expected loaded')
    const m0 = loadedOnce.messages[0] as { content: string }
    m0.content = 'mutated'
    const second = await s.load('a')
    expect(second?.messages[0]?.content).toBe('m1')
  })
})
