import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSessionRecord, loadSession, saveSession } from '../src/persistent-workflow-store.js'
import { MemoryRunStore, SqliteRunStore, type StateStore } from '../src/run-store.js'

function stores(): Array<[string, StateStore]> {
  const dir = mkdtempSync(join(tmpdir(), 'skelm-sessions-'))
  return [
    ['memory', new MemoryRunStore()],
    ['sqlite', new SqliteRunStore({ path: join(dir, 'runs.db') })],
  ]
}

describe('persistent-workflow session store', () => {
  for (const [label, store] of stores()) {
    describe(label, () => {
      it('returns undefined for an unknown session', async () => {
        await expect(loadSession(store, 'wf-x', 'chat-1')).resolves.toBeUndefined()
      })

      it('round-trips a record and keeps the sessionId stable across saves', async () => {
        const rec = createSessionRecord('wf-1', 'chat-1')
        await saveSession(store, rec)

        const loaded = await loadSession(store, 'wf-1', 'chat-1')
        expect(loaded?.sessionId).toBe(rec.sessionId)
        expect(loaded?.workflowId).toBe('wf-1')
        expect(loaded?.sessionKey).toBe('chat-1')
        expect(loaded?.turns).toBe(0)

        // Append a turn and persist again; sessionId must not change.
        const next = {
          ...(loaded as NonNullable<typeof loaded>),
          turns: 1,
          conversation: { version: 1, messages: [{ role: 'user', content: 'hi' }] },
        }
        await saveSession(store, next)
        const reloaded = await loadSession(store, 'wf-1', 'chat-1')
        expect(reloaded?.sessionId).toBe(rec.sessionId)
        expect(reloaded?.turns).toBe(1)
        expect(reloaded?.conversation).toEqual(next.conversation)
      })

      it('isolates sessions by (workflowId, sessionKey)', async () => {
        const a = createSessionRecord('wf-1', 'chat-A')
        const b = createSessionRecord('wf-1', 'chat-B')
        await saveSession(store, a)
        await saveSession(store, b)
        expect(a.sessionId).not.toBe(b.sessionId)
        expect((await loadSession(store, 'wf-1', 'chat-A'))?.sessionId).toBe(a.sessionId)
        expect((await loadSession(store, 'wf-1', 'chat-B'))?.sessionId).toBe(b.sessionId)
      })
    })
  }
})
