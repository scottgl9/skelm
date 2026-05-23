import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../src/builders.js'
import { MemoryRunStore } from '../src/run-store.js'
import { runPipeline } from '../src/runner.js'
import { createThreadHost } from '../src/threads.js'

describe('ctx.threads — conversation thread helper', () => {
  it('records last-seen and reports unseen comments across two runs of the same pipeline', async () => {
    const store = new MemoryRunStore()
    const ref = { kind: 'github-pr', key: 'octo/demo#42' }

    const ingest = pipeline({
      id: 'ingest',
      steps: [
        code({
          id: 'append',
          run: async (ctx) => {
            const t = ctx.threads.get(ref)
            await t.appendComment('c1', { body: 'hello' })
            await t.appendComment('c2', { body: 'world' })
            return { ok: true }
          },
        }),
      ],
    })
    await runPipeline(ingest, undefined, { stateStore: store })

    const review = pipeline({
      id: 'review',
      steps: [
        code({
          id: 'read',
          run: async (ctx) => {
            const t = ctx.threads.get(ref)
            const lastSeen = await t.lastSeen()
            expect(lastSeen).toBeUndefined()
            const unseen: { commentId: string; comment: unknown }[] = []
            for await (const c of t.unseenSince(lastSeen)) unseen.push(c)
            // markSeen the latest one for the next iteration's invariants.
            await t.markSeen('c2')
            return { unseen }
          },
        }),
      ],
    })
    const r = await runPipeline(review, undefined, { stateStore: store })
    expect(r.status).toBe('completed')
    const out = r.output as { unseen: { commentId: string }[] }
    expect(out.unseen.map((c) => c.commentId)).toEqual(['c1', 'c2'])

    // Append a third comment, then a follow-up run sees only the new one.
    const append3 = pipeline({
      id: 'append-3',
      steps: [
        code({
          id: 'go',
          run: async (ctx) => {
            const t = ctx.threads.get(ref)
            await t.appendComment('c3', { body: 'follow-up' })
            return {}
          },
        }),
      ],
    })
    await runPipeline(append3, undefined, { stateStore: store })

    const followUp = pipeline({
      id: 'follow-up',
      steps: [
        code({
          id: 'read',
          run: async (ctx) => {
            const t = ctx.threads.get(ref)
            const lastSeen = await t.lastSeen()
            const unseen: { commentId: string }[] = []
            for await (const c of t.unseenSince(lastSeen)) unseen.push(c)
            return { lastSeen, unseen: unseen.map((c) => c.commentId) }
          },
        }),
      ],
    })
    const r2 = await runPipeline(followUp, undefined, { stateStore: store })
    expect(r2.output).toEqual({ lastSeen: 'c2', unseen: ['c3'] })
  })

  it('scopes thread state by (kind, key) — distinct refs do not collide', async () => {
    const store = new MemoryRunStore()
    const host = createThreadHost(store)
    const a = host.get({ kind: 'github-pr', key: 'a/r#1' })
    const b = host.get({ kind: 'github-pr', key: 'a/r#2' })
    await a.markSeen('comment-A')
    await b.markSeen('comment-B')
    expect(await a.lastSeen()).toBe('comment-A')
    expect(await b.lastSeen()).toBe('comment-B')
  })

  it('rejects refs missing kind or key', () => {
    const store = new MemoryRunStore()
    const host = createThreadHost(store)
    expect(() => host.get({ kind: '', key: 'x' })).toThrow()
    expect(() => host.get({ kind: 'x', key: '' })).toThrow()
  })

  it('unseenSince without an id yields every appended comment', async () => {
    const store = new MemoryRunStore()
    const host = createThreadHost(store)
    const t = host.get({ kind: 'slack', key: 'C123:1700000000.000100' })
    await t.appendComment('x', { body: 'one' })
    await t.appendComment('y', { body: 'two' })
    const got: string[] = []
    for await (const c of t.unseenSince()) got.push(c.commentId)
    expect(got).toEqual(['x', 'y'])
  })

  it('appendComment deduplicates by commentId — re-appending the same id is a no-op', async () => {
    const store = new MemoryRunStore()
    const host = createThreadHost(store)
    const t = host.get({ kind: 'github-pr', key: 'octo/demo#dedup' })

    // First append — stored.
    await t.appendComment('c1', { body: 'first' })
    await t.appendComment('c2', { body: 'second' })

    // Re-append the same ids (simulates a second CLI run hitting the same store).
    await t.appendComment('c1', { body: 'first again' })
    await t.appendComment('c2', { body: 'second again' })
    await t.appendComment('c3', { body: 'third' })

    const all: string[] = []
    for await (const c of t.unseenSince()) all.push(c.commentId)
    // Duplicates must not appear — stream should be c1, c2, c3 in insertion order.
    expect(all).toEqual(['c1', 'c2', 'c3'])
  })

  it('unseenSince after dedup yields correct results', async () => {
    const store = new MemoryRunStore()
    const host = createThreadHost(store)
    const t = host.get({ kind: 'github-pr', key: 'octo/demo#dedup2' })

    await t.appendComment('c1', { body: 'a' })
    await t.appendComment('c2', { body: 'b' })
    await t.markSeen('c1')

    // Simulate second run: re-append c1+c2, add c3.
    await t.appendComment('c1', { body: 'a again' }) // deduped
    await t.appendComment('c2', { body: 'b again' }) // deduped
    await t.appendComment('c3', { body: 'c' })

    const unseen: string[] = []
    for await (const c of t.unseenSince('c1')) unseen.push(c.commentId)
    // unseenSince('c1') should yield c2 and c3, not duplicates.
    expect(unseen).toEqual(['c2', 'c3'])
  })
})
