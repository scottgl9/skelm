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
})
