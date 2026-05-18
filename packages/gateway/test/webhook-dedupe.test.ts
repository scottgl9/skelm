import { describe, expect, it } from 'vitest'
import { InMemoryDedupeStore } from '../src/triggers/dedupe-store.js'

describe('InMemoryDedupeStore', () => {
  it('records the first delivery as fresh and rejects the replay within the TTL', () => {
    const store = new InMemoryDedupeStore()
    expect(store.recordIfFresh('trigger-1', 'delivery-A', 60_000)).toBe(true)
    expect(store.recordIfFresh('trigger-1', 'delivery-A', 60_000)).toBe(false)
  })

  it('keys are scoped by trigger id', () => {
    const store = new InMemoryDedupeStore()
    expect(store.recordIfFresh('trigger-1', 'delivery-A', 60_000)).toBe(true)
    // Same delivery id, different trigger — must not collide.
    expect(store.recordIfFresh('trigger-2', 'delivery-A', 60_000)).toBe(true)
  })

  it('treats empty triggerId or key as fresh so callers do not accidentally dedupe', () => {
    const store = new InMemoryDedupeStore()
    expect(store.recordIfFresh('', 'x', 60_000)).toBe(true)
    expect(store.recordIfFresh('t', '', 60_000)).toBe(true)
    // Empty inputs are not stored.
    expect(store.size()).toBe(0)
  })

  it('expires entries past their TTL — a replay after expiry is fresh again', async () => {
    const store = new InMemoryDedupeStore()
    expect(store.recordIfFresh('t', 'd', 1)).toBe(true)
    await new Promise((r) => setTimeout(r, 5))
    expect(store.recordIfFresh('t', 'd', 1)).toBe(true)
  })

  it('clear() drops every entry', () => {
    const store = new InMemoryDedupeStore()
    store.recordIfFresh('t', 'd1', 60_000)
    store.recordIfFresh('t', 'd2', 60_000)
    expect(store.size()).toBe(2)
    store.clear()
    expect(store.size()).toBe(0)
    expect(store.recordIfFresh('t', 'd1', 60_000)).toBe(true)
  })
})
