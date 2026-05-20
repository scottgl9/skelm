import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ArtifactQuotaExceededError,
  type ArtifactStore,
  MemoryRunStore,
  SqliteRunStore,
} from '../src/run-store.js'

function contractSuite(name: string, makeStore: () => ArtifactStore): void {
  describe(`ArtifactStore — ${name}`, () => {
    it('round-trips bytes by ref and preserves mime + step scoping', async () => {
      const store = makeStore()
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      const desc = await store.putArtifact({
        runId: 'run-1',
        stepId: 'capture',
        name: 'screen.png',
        mimeType: 'image/png',
        data: png,
      })
      expect(desc.size).toBe(4)
      expect(desc.mimeType).toBe('image/png')
      expect(desc.stepId).toBe('capture')

      const fetched = await store.getArtifact(desc)
      expect(fetched).not.toBeNull()
      expect(Buffer.from(fetched!.data).equals(png)).toBe(true)
      expect(fetched!.descriptor.name).toBe('screen.png')

      const collected: string[] = []
      for await (const d of store.listArtifacts('run-1')) {
        collected.push(d.artifactId)
      }
      expect(collected).toEqual([desc.artifactId])

      const scoped: string[] = []
      for await (const d of store.listArtifacts('run-1', { stepId: 'other' })) {
        scoped.push(d.artifactId)
      }
      expect(scoped).toEqual([])
    })

    it('accepts string data as utf-8', async () => {
      const store = makeStore()
      const desc = await store.putArtifact({
        runId: 'run-1',
        name: 'note.txt',
        mimeType: 'text/plain',
        data: 'hello world',
      })
      const fetched = await store.getArtifact(desc)
      expect(Buffer.from(fetched!.data).toString('utf8')).toBe('hello world')
    })

    it('returns null for unknown refs', async () => {
      const store = makeStore()
      expect(await store.getArtifact({ runId: 'r', artifactId: 'nope' })).toBeNull()
    })
  })
}

contractSuite('MemoryRunStore', () => new MemoryRunStore())
contractSuite('SqliteRunStore', () => new SqliteRunStore())

describe('ArtifactStore quota — adversarial', () => {
  it('MemoryRunStore rejects writes that would exceed the per-run quota', async () => {
    const store = new MemoryRunStore({ artifactQuotaBytes: 16 })
    await store.putArtifact({
      runId: 'r',
      name: 'a',
      mimeType: 'application/octet-stream',
      data: new Uint8Array(10),
    })
    await expect(
      store.putArtifact({
        runId: 'r',
        name: 'b',
        mimeType: 'application/octet-stream',
        data: new Uint8Array(10),
      }),
    ).rejects.toBeInstanceOf(ArtifactQuotaExceededError)

    // The rejected write must not have landed.
    const seen: string[] = []
    for await (const d of store.listArtifacts('r')) seen.push(d.name)
    expect(seen).toEqual(['a'])
  })

  it('SqliteRunStore rejects writes that would exceed the per-run quota', async () => {
    const store = new SqliteRunStore({ artifactQuotaBytes: 16 })
    await store.putArtifact({
      runId: 'r',
      name: 'a',
      mimeType: 'application/octet-stream',
      data: new Uint8Array(10),
    })
    await expect(
      store.putArtifact({
        runId: 'r',
        name: 'b',
        mimeType: 'application/octet-stream',
        data: new Uint8Array(10),
      }),
    ).rejects.toBeInstanceOf(ArtifactQuotaExceededError)
    const seen: string[] = []
    for await (const d of store.listArtifacts('r')) seen.push(d.name)
    expect(seen).toEqual(['a'])
    store.close()
  })
})

describe('SqliteRunStore artifact migration', () => {
  it('re-opens an existing on-disk DB and preserves artifact rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-art-'))
    const path = join(dir, 'store.sqlite')
    const a = new SqliteRunStore({ path })
    const desc = await a.putArtifact({
      runId: 'run-x',
      name: 'a.png',
      mimeType: 'image/png',
      data: Buffer.from([1, 2, 3]),
    })
    a.close()

    const b = new SqliteRunStore({ path })
    const fetched = await b.getArtifact(desc)
    expect(fetched).not.toBeNull()
    expect(Array.from(fetched!.data)).toEqual([1, 2, 3])
    b.close()
  })
})
