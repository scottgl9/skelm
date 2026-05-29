/**
 * Plan §4.5: durable advisory lock on persistent-workflow sessions.
 *
 * Before this change, two gateway replicas (or two dispatch retries in
 * the same process across a crash that lost the in-memory withSessionLock
 * map) could race the load → run → save cycle on the same sessionKey and
 * overwrite each other's conversation history. The new lock is a cas-based
 * `active: { ownerId, since }` field on the persisted record; acquireSession
 * rejects concurrent acquires from a different owner with a typed error,
 * and releaseSession clears it.
 */
import { MemoryRunStore } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import {
  PersistentSessionLockedError,
  acquireSession,
  loadSession,
  releaseSession,
  saveSession,
} from '../src/persistent-workflow-store.js'

describe('persistent-workflow session lock (plan §4.5)', () => {
  it('acquireSession returns a record with the active lock set', async () => {
    const store = new MemoryRunStore()
    const rec = await acquireSession(store, 'wf-1', 'chat-42', 'owner-A')
    expect(rec.workflowId).toBe('wf-1')
    expect(rec.sessionKey).toBe('chat-42')
    expect(rec.active?.ownerId).toBe('owner-A')
    expect(typeof rec.active?.since).toBe('number')
  })

  it('second acquire by a different owner throws PersistentSessionLockedError', async () => {
    const store = new MemoryRunStore()
    await acquireSession(store, 'wf-1', 'chat', 'owner-A')
    await expect(acquireSession(store, 'wf-1', 'chat', 'owner-B')).rejects.toBeInstanceOf(
      PersistentSessionLockedError,
    )
  })

  it('acquire is re-entrant for the same owner', async () => {
    const store = new MemoryRunStore()
    const first = await acquireSession(store, 'wf-1', 'chat', 'owner-A')
    const second = await acquireSession(store, 'wf-1', 'chat', 'owner-A')
    expect(second.active?.ownerId).toBe('owner-A')
    expect(second.sessionId).toBe(first.sessionId)
  })

  it('releaseSession clears the lock so another owner can take it', async () => {
    const store = new MemoryRunStore()
    await acquireSession(store, 'wf-1', 'chat', 'owner-A')
    await releaseSession(store, 'wf-1', 'chat', 'owner-A')
    const after = await loadSession(store, 'wf-1', 'chat')
    expect(after?.active).toBeUndefined()
    // Another owner can now acquire without error.
    const rec = await acquireSession(store, 'wf-1', 'chat', 'owner-B')
    expect(rec.active?.ownerId).toBe('owner-B')
  })

  it('releaseSession by a non-holder is a no-op', async () => {
    const store = new MemoryRunStore()
    await acquireSession(store, 'wf-1', 'chat', 'owner-A')
    await releaseSession(store, 'wf-1', 'chat', 'owner-B')
    // Lock is still held by owner-A; owner-C cannot acquire.
    await expect(acquireSession(store, 'wf-1', 'chat', 'owner-C')).rejects.toBeInstanceOf(
      PersistentSessionLockedError,
    )
  })

  it('saveSession preserves the active lock so it survives mid-turn writes', async () => {
    const store = new MemoryRunStore()
    const rec = await acquireSession(store, 'wf-1', 'chat', 'owner-A')
    await saveSession(store, { ...rec, conversation: [{ role: 'user', content: 'hi' }], turns: 1 })
    const reloaded = await loadSession(store, 'wf-1', 'chat')
    expect(reloaded?.active?.ownerId).toBe('owner-A')
    expect(reloaded?.turns).toBe(1)
  })
})
