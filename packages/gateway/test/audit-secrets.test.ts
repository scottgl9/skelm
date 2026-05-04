import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChainAuditWriter, FileSecretResolver } from '../src/index.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skelm-audit-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ChainAuditWriter', () => {
  it('appends entries with sequential seq and chained prevHash', async () => {
    const path = join(dir, 'audit.jsonl')
    const w = new ChainAuditWriter(path)
    await w.write({ actor: 'gateway', action: 'start' })
    await w.write({ actor: 'gateway', action: 'permission.deny', details: { dim: 'fs' } })
    await w.write({ actor: 'cli', action: 'secrets.set', details: { name: 'OPENAI_KEY' } })
    const all = await w.readAll()
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(all[0]?.prevHash).toBe('0'.repeat(64))
    expect(all[1]?.prevHash).toBe(all[0]?.entryHash)
    expect(all[2]?.prevHash).toBe(all[1]?.entryHash)
  })

  it('verify() returns null on a clean chain', async () => {
    const path = join(dir, 'audit.jsonl')
    const w = new ChainAuditWriter(path)
    for (let i = 0; i < 5; i++) await w.write({ actor: 'a', action: `act-${i}` })
    expect(await w.verify()).toBeNull()
  })

  it('verify() detects tampered entries', async () => {
    const path = join(dir, 'audit.jsonl')
    const w = new ChainAuditWriter(path)
    await w.write({ actor: 'a', action: 'one' })
    await w.write({ actor: 'a', action: 'two' })
    const raw = await fs.readFile(path, 'utf8')
    const tampered = raw.replace('"action":"two"', '"action":"TWO"')
    await fs.writeFile(path, tampered)
    const breach = await new ChainAuditWriter(path).verify()
    expect(breach).not.toBeNull()
    expect(breach?.seq).toBe(2)
  })

  it('continues seq after restart from existing chain', async () => {
    const path = join(dir, 'audit.jsonl')
    const a = new ChainAuditWriter(path)
    await a.write({ actor: 'gateway', action: 'start' })
    await a.write({ actor: 'gateway', action: 'reload' })
    const b = new ChainAuditWriter(path)
    await b.write({ actor: 'gateway', action: 'stop' })
    const all = await b.readAll()
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(await b.verify()).toBeNull()
  })
})

describe('FileSecretResolver', () => {
  it('set / resolve / list / unset roundtrip', async () => {
    const path = join(dir, 'secrets.json')
    const r = new FileSecretResolver(path)
    expect(await r.list()).toEqual([])
    expect(await r.resolve('FOO')).toBeUndefined()

    await r.set('FOO', 'bar')
    await r.set('OPENAI_KEY', 'sk-xxx')
    expect(await r.list()).toEqual(['FOO', 'OPENAI_KEY'])
    expect(await r.resolve('FOO')).toBe('bar')

    expect(await r.unset('FOO')).toBe(true)
    expect(await r.unset('FOO')).toBe(false)
    expect(await r.list()).toEqual(['OPENAI_KEY'])
  })

  it('writes the file with mode 0600', async () => {
    const path = join(dir, 'secrets.json')
    const r = new FileSecretResolver(path)
    await r.set('K', 'v')
    const stat = await fs.stat(path)
    // Mask out file-type bits, compare permission bits.
    expect(stat.mode & 0o777).toBe(0o600)
  })
})
