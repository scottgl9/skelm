import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackendSessionError } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  FileSessionStore,
  InMemorySessionStore,
  type SerializedSession,
  type SessionStore,
  assertSerializedSession,
  exportSession,
  forkSession,
  importSession,
} from '../../src/index.js'

const sample = (text: string): SerializedSession => ({
  version: 1,
  systemPrompt: 'be helpful',
  messages: [
    { role: 'user', content: text },
    {
      role: 'assistant',
      content: `re: ${text}`,
      toolCalls: [{ id: 'c1', name: 'ls', arguments: '{}' }],
    },
    { role: 'tool', content: 'listing', toolCallId: 'c1' },
  ],
})

function lifecycleSuite(name: string, makeStore: () => SessionStore): void {
  describe(`session lifecycle verbs (${name})`, () => {
    it('fork copies a session under a new id; the copies are independent', async () => {
      const store = makeStore()
      await store.save('orig', sample('hello'))

      const forked = await forkSession(store, 'orig', 'copy')
      expect(forked).toEqual(sample('hello'))
      expect(await store.load('copy')).toEqual(sample('hello'))

      // Mutating the fork must not touch the original.
      await store.save('copy', sample('changed'))
      expect(await store.load('orig')).toEqual(sample('hello'))
      expect((await store.list()).sort()).toEqual(['copy', 'orig'])
    })

    it('fork of a missing source throws BackendSessionError', async () => {
      const store = makeStore()
      await expect(forkSession(store, 'absent', 'copy')).rejects.toThrow(BackendSessionError)
      expect(await store.load('copy')).toBeUndefined()
    })

    it('export → import round-trips across stores', async () => {
      const source = makeStore()
      const target = makeStore()
      await source.save('s1', sample('portable'))

      const exported = await exportSession(source, 's1')
      // Simulate the on-the-wire form: plain JSON, no shared references.
      const wire: unknown = JSON.parse(JSON.stringify(exported))
      const imported = await importSession(target, 's1-imported', wire)

      expect(imported).toEqual(sample('portable'))
      expect(await target.load('s1-imported')).toEqual(sample('portable'))
    })

    it('export of a missing session throws BackendSessionError', async () => {
      const store = makeStore()
      await expect(exportSession(store, 'absent')).rejects.toThrow(BackendSessionError)
    })

    it('import validates the payload and persists nothing on rejection', async () => {
      const store = makeStore()
      await expect(importSession(store, 'bad', { version: 2, messages: [] })).rejects.toThrow(
        BackendSessionError,
      )
      await expect(importSession(store, 'bad', { version: 1 })).rejects.toThrow(BackendSessionError)
      await expect(
        importSession(store, 'bad', { version: 1, messages: [{ role: 'wizard', content: 'x' }] }),
      ).rejects.toThrow(BackendSessionError)
      await expect(
        importSession(store, 'bad', { version: 1, messages: [{ role: 'user', content: 7 }] }),
      ).rejects.toThrow(BackendSessionError)
      expect(await store.load('bad')).toBeUndefined()
    })
  })
}

lifecycleSuite('InMemorySessionStore', () => new InMemorySessionStore())

describe('lifecycle verbs on FileSessionStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skelm-agent-lifecycle-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('fork + export/import round-trip through disk', async () => {
    const store = new FileSessionStore(dir)
    await store.save('orig', sample('on disk'))

    await forkSession(store, 'orig', 'copy')
    const exported = await exportSession(store, 'copy')
    const imported = await importSession(store, 'copy-2', JSON.parse(JSON.stringify(exported)))

    expect(imported).toEqual(sample('on disk'))
    expect((await store.list()).sort()).toEqual(['copy', 'copy-2', 'orig'])
  })
})

describe('assertSerializedSession', () => {
  it('accepts a valid session and returns it', () => {
    const s = sample('ok')
    expect(assertSerializedSession(JSON.parse(JSON.stringify(s)))).toEqual(s)
  })

  it('rejects non-objects', () => {
    expect(() => assertSerializedSession('nope')).toThrow(BackendSessionError)
    expect(() => assertSerializedSession(null)).toThrow(BackendSessionError)
    expect(() => assertSerializedSession([sample('x')])).toThrow(BackendSessionError)
  })
})
