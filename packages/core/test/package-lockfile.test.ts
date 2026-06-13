import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConfigError } from '../src/errors.js'
import {
  SKELM_LOCKFILE_NAME,
  type SkelmLockfileEntry,
  readLockfile,
  removeLockfileEntry,
  updateLockfileEntry,
  writeLockfile,
} from '../src/packages/lockfile.js'

function entry(name: string, patch: Partial<SkelmLockfileEntry> = {}): SkelmLockfileEntry {
  return {
    name,
    version: '1.0.0',
    resolved: `/tmp/source/${name}`,
    integrity: 'sha256:abc',
    installedAt: '2026-06-12T00:00:00.000Z',
    ...patch,
  }
}

let projectRoot: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-lockfile-'))
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

describe('skelm.lock.json helpers', () => {
  it('reads a missing lockfile as empty', async () => {
    await expect(readLockfile(projectRoot)).resolves.toEqual({
      lockfileVersion: 1,
      packages: {},
    })
  })

  it('round-trips entries through write and read', async () => {
    const a = entry('@skelm/a', { requiredSkelmVersion: '>=0.4.0' })
    const b = entry('@skelm/b', { version: '2.3.4' })
    await writeLockfile(projectRoot, { lockfileVersion: 1, packages: { [a.name]: a, [b.name]: b } })

    const read = await readLockfile(projectRoot)
    expect(read.packages['@skelm/a']).toEqual(a)
    expect(read.packages['@skelm/b']).toEqual(b)
  })

  it('serializes with sorted keys and stable field order regardless of insertion order', async () => {
    const a = entry('@skelm/a')
    const b = entry('@skelm/b')
    await writeLockfile(projectRoot, { lockfileVersion: 1, packages: { [b.name]: b, [a.name]: a } })
    const firstBytes = await readFile(join(projectRoot, SKELM_LOCKFILE_NAME), 'utf8')

    await writeLockfile(projectRoot, { lockfileVersion: 1, packages: { [a.name]: a, [b.name]: b } })
    const secondBytes = await readFile(join(projectRoot, SKELM_LOCKFILE_NAME), 'utf8')

    expect(secondBytes).toBe(firstBytes)
    expect(firstBytes.indexOf('@skelm/a')).toBeLessThan(firstBytes.indexOf('@skelm/b'))
    expect(firstBytes.endsWith('\n')).toBe(true)
  })

  it('writes atomically and leaves no tmp files behind', async () => {
    await writeLockfile(projectRoot, { lockfileVersion: 1, packages: { x: entry('x') } })
    await writeLockfile(projectRoot, { lockfileVersion: 1, packages: { y: entry('y') } })
    const files = await readdir(projectRoot)
    expect(files).toEqual([SKELM_LOCKFILE_NAME])
    const read = await readLockfile(projectRoot)
    expect(Object.keys(read.packages)).toEqual(['y'])
  })

  it('updateLockfileEntry upserts and removeLockfileEntry drops entries', async () => {
    await updateLockfileEntry(projectRoot, entry('@skelm/a'))
    await updateLockfileEntry(projectRoot, entry('@skelm/b'))
    const updated = await updateLockfileEntry(projectRoot, entry('@skelm/a', { version: '1.1.0' }))
    expect(updated.packages['@skelm/a']?.version).toBe('1.1.0')

    const afterRemove = await removeLockfileEntry(projectRoot, '@skelm/a')
    expect(Object.keys(afterRemove.packages)).toEqual(['@skelm/b'])
    expect(Object.keys((await readLockfile(projectRoot)).packages)).toEqual(['@skelm/b'])
  })

  it('round-trips a trustLevel and rejects an invalid one', async () => {
    const e = entry('@skelm/a', { trustLevel: 'npm' })
    await writeLockfile(projectRoot, { lockfileVersion: 1, packages: { [e.name]: e } })
    expect((await readLockfile(projectRoot)).packages['@skelm/a']?.trustLevel).toBe('npm')

    const path = join(projectRoot, SKELM_LOCKFILE_NAME)
    await writeFile(
      path,
      JSON.stringify({
        lockfileVersion: 1,
        packages: { x: { ...entry('x'), trustLevel: 'bogus' } },
      }),
    )
    await expect(readLockfile(projectRoot)).rejects.toThrow('invalid `trustLevel`')
  })

  it('throws ConfigError on malformed JSON or invalid shapes', async () => {
    const path = join(projectRoot, SKELM_LOCKFILE_NAME)

    await writeFile(path, '{ nope')
    await expect(readLockfile(projectRoot)).rejects.toThrow(ConfigError)

    await writeFile(path, JSON.stringify({ lockfileVersion: 2, packages: {} }))
    await expect(readLockfile(projectRoot)).rejects.toThrow('`lockfileVersion` must be 1')

    await writeFile(path, JSON.stringify({ lockfileVersion: 1, packages: [] }))
    await expect(readLockfile(projectRoot)).rejects.toThrow('`packages` must be an object')

    await writeFile(
      path,
      JSON.stringify({ lockfileVersion: 1, packages: { x: { name: 'x', version: '1.0.0' } } }),
    )
    await expect(readLockfile(projectRoot)).rejects.toThrow('missing a string `resolved`')

    await writeFile(
      path,
      JSON.stringify({
        lockfileVersion: 1,
        packages: { x: { ...entry('x'), requiredSkelmVersion: 4 } },
      }),
    )
    await expect(readLockfile(projectRoot)).rejects.toThrow('non-string `requiredSkelmVersion`')
  })
})
