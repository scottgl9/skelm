import { describe, expect, it } from 'vitest'
import { sessionLockCount, withSessionLock } from '../src/triggers/persistent-workflow-turn.js'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Regression for the sessionLocks leak: the cleanup used to compare against a
// freshly-built `next.catch(...)` promise that was never `===` the stored one,
// so the map entry was never deleted — unbounded growth keyed by session.
describe('withSessionLock', () => {
  it('releases the map entry after a turn settles (no leak)', async () => {
    await withSessionLock('wf:a', async () => 'ok')
    expect(sessionLockCount()).toBe(0)
  })

  it('serializes concurrent calls on the same key and still cleans up', async () => {
    const order: number[] = []
    const a = withSessionLock('wf:a', async () => {
      order.push(1)
      await delay(10)
      order.push(2)
    })
    const b = withSessionLock('wf:a', async () => {
      order.push(3)
    })
    await Promise.all([a, b])
    expect(order).toEqual([1, 2, 3])
    expect(sessionLockCount()).toBe(0)
  })

  it('cleans up even when the locked function rejects', async () => {
    await expect(
      withSessionLock('wf:a', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(sessionLockCount()).toBe(0)
  })
})
