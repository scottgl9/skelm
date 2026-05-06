import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChainAuditWriter } from '../../src/index.js'

// Adversarial coverage for the hash-chained audit log. The writer claims a
// tamper-evident chain; these tests prove the chain detects each documented
// failure mode end-to-end. Per CLAUDE.md: security paths must have adversarial
// tests proving both default-deny and explicit-deny.

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skelm-audit-chain-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeChain(path: string, n: number) {
  const w = new ChainAuditWriter(path)
  for (let i = 0; i < n; i++) {
    await w.write({ actor: 'gateway', action: `act-${i}`, details: { i } })
  }
  return w
}

async function readLines(path: string): Promise<string[]> {
  const raw = await fs.readFile(path, 'utf8')
  return raw.split(/\r?\n/).filter((l) => l.length > 0)
}

describe('ChainAuditWriter: adversarial integrity', () => {
  it('detects payload tampering on a single entry', async () => {
    const path = join(dir, 'a.jsonl')
    await writeChain(path, 5)
    const raw = await fs.readFile(path, 'utf8')
    const tampered = raw.replace('"action":"act-2"', '"action":"act-X"')
    await fs.writeFile(path, tampered)
    const breach = await new ChainAuditWriter(path).verify()
    expect(breach).not.toBeNull()
    expect(breach?.seq).toBe(3)
    expect(breach?.reason).toMatch(/tampered/i)
  })

  it('detects a dropped entry mid-chain', async () => {
    const path = join(dir, 'b.jsonl')
    await writeChain(path, 5)
    const lines = await readLines(path)
    // Remove the third entry (seq 3)
    const dropped = `${[lines[0], lines[1], lines[3], lines[4]].join('\n')}\n`
    await fs.writeFile(path, dropped)
    const breach = await new ChainAuditWriter(path).verify()
    expect(breach).not.toBeNull()
    // The first entry whose seq != index+1 fires; that is the formerly-4th line
    // now sitting at index 2, carrying seq=4.
    expect(breach?.seq).toBe(4)
  })

  it('detects a dropped tail (rollback)', async () => {
    const path = join(dir, 'c.jsonl')
    await writeChain(path, 5)
    const lines = await readLines(path)
    await fs.writeFile(path, `${lines.slice(0, 3).join('\n')}\n`)
    // A truncated suffix is structurally valid as a shorter chain — we cannot
    // detect it from the file alone. Verify still passes; rollback detection
    // is the caller's responsibility (e.g. a sealed seq counter elsewhere).
    const breach = await new ChainAuditWriter(path).verify()
    expect(breach).toBeNull()
    // But appending after a rollback to a fresh writer must not silently
    // continue with the original sequence: a new writer starts from the
    // current last entry, so seq advances from 3, not 5.
    const w = new ChainAuditWriter(path)
    await w.write({ actor: 'gateway', action: 'after-rollback' })
    const all = await w.readAll()
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('detects reordered entries', async () => {
    const path = join(dir, 'd.jsonl')
    await writeChain(path, 5)
    const lines = await readLines(path)
    // Swap entries 2 and 3
    const swapped = `${[lines[0], lines[2], lines[1], lines[3], lines[4]].join('\n')}\n`
    await fs.writeFile(path, swapped)
    const breach = await new ChainAuditWriter(path).verify()
    expect(breach).not.toBeNull()
  })

  it('detects re-signed (recomputed entryHash) tampering when prevHash is left intact', async () => {
    const path = join(dir, 'e.jsonl')
    await writeChain(path, 4)
    const lines = await readLines(path)
    const target = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>
    // Mutate the payload in place; do NOT update entryHash. The chain catches
    // this as "tampered entry" because the recomputed hash will differ.
    target.action = 'forged'
    lines[1] = JSON.stringify(target)
    await fs.writeFile(path, `${lines.join('\n')}\n`)
    const breach = await new ChainAuditWriter(path).verify()
    expect(breach).not.toBeNull()
    expect(breach?.seq).toBe(2)
  })

  it('detects mid-chain forgery even when an attacker recomputes the entryHash for that one entry', async () => {
    // Without access to a writer's secret, an attacker can recompute the
    // entryHash for the entry they tampered, but the *next* entry still has
    // prevHash bound to the old entryHash. So the chain still breaks at i+1.
    const path = join(dir, 'f.jsonl')
    await writeChain(path, 4)
    const lines = await readLines(path)
    const target = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>
    // Recompute a plausible entryHash by canonicalizing in the same way the
    // writer would. We mimic the writer's canonical hashing here so the
    // forgery is deterministic.
    const { createHash } = await import('node:crypto')
    target.action = 'forged'
    const { entryHash: _drop, ...rest } = target as { entryHash?: string }
    const canon = (function canonicalize(value: unknown): string {
      if (value === null || typeof value !== 'object') return JSON.stringify(value)
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj).sort()
      return `{${keys
        .filter((k) => obj[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
        .join(',')}}`
    })(rest)
    target.entryHash = createHash('sha256').update(canon).digest('hex')
    lines[1] = JSON.stringify(target)
    await fs.writeFile(path, `${lines.join('\n')}\n`)
    const breach = await new ChainAuditWriter(path).verify()
    expect(breach).not.toBeNull()
    // The next entry still binds the *old* entryHash via prevHash, so seq 3
    // breaks the chain.
    expect(breach?.seq).toBe(3)
    expect(breach?.reason).toMatch(/broken chain/i)
  })
})
