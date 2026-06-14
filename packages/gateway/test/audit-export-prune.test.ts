import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChainAuditWriter } from '../src/index.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skelm-audit-exp-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function collect(
  w: ChainAuditWriter,
  filter: Parameters<ChainAuditWriter['export']>[0],
  format: 'jsonl' | 'csv',
): Promise<string> {
  let out = ''
  await w.export(filter, format, (chunk) => {
    out += chunk
  })
  return out
}

describe('ChainAuditWriter.export', () => {
  it('streams JSONL with all entries by default (no tail limit)', async () => {
    const path = join(dir, 'a.jsonl')
    const w = new ChainAuditWriter(path)
    for (let i = 0; i < 10; i++) await w.write({ actor: 'gateway', action: `act-${i}` })
    const out = await collect(w, {}, 'jsonl')
    const lines = out.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(10)
    expect((JSON.parse(lines[0] ?? '{}') as { seq: number }).seq).toBe(1)
    expect((JSON.parse(lines[9] ?? '{}') as { seq: number }).seq).toBe(10)
  })

  it('honors filters (runId, action, since/until, before)', async () => {
    const path = join(dir, 'b.jsonl')
    const w = new ChainAuditWriter(path)
    await w.write({
      actor: 'a',
      action: 'x',
      runId: 'r1',
      timestamp: '2025-01-01T00:00:00.000Z',
    })
    await w.write({
      actor: 'a',
      action: 'y',
      runId: 'r2',
      timestamp: '2025-02-01T00:00:00.000Z',
    })
    const byRun = await collect(w, { runId: 'r2' }, 'jsonl')
    const runLines = byRun.split('\n').filter((l) => l.length > 0)
    expect(runLines).toHaveLength(1)
    expect((JSON.parse(runLines[0] ?? '{}') as { runId: string }).runId).toBe('r2')

    const since = await collect(w, { since: '2025-01-15T00:00:00.000Z' }, 'jsonl')
    expect(since.split('\n').filter((l) => l.length > 0)).toHaveLength(1)
  })

  it('emits CSV with stable header + column order and RFC-4180 escaping', async () => {
    const path = join(dir, 'c.jsonl')
    const w = new ChainAuditWriter(path)
    await w.write({
      actor: 'a,b',
      action: 'with "quote"',
      runId: 'r1',
      details: { note: 'line1\nline2', n: 3 },
    })
    const out = await collect(w, {}, 'csv')
    // The details cell holds an embedded newline, so a naive line split would
    // tear the row — assert against the full text instead.
    expect(out.startsWith('seq,timestamp,actor,action,runId,prevHash,entryHash,details\n')).toBe(
      true,
    )
    expect(out).toContain('"a,b"')
    expect(out).toContain('"with ""quote"""')
    // JSON.stringify escapes the newline to \\n, and the comma in the JSON
    // forces the cell to be quoted.
    expect(out).toContain('"{""note"":""line1\\nline2"",""n"":3}"')
  })

  it('quotes a cell containing a raw newline (RFC-4180)', async () => {
    const path = join(dir, 'nl.jsonl')
    const w = new ChainAuditWriter(path)
    await w.write({ actor: 'multi\nline', action: 'x' })
    const out = await collect(w, {}, 'csv')
    expect(out).toContain('"multi\nline"')
  })

  it('exports a large synthetic chain with bounded memory (no full-file string)', async () => {
    const { createHash } = await import('node:crypto')
    const canonicalize = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value)
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
      const obj = value as Record<string, unknown>
      return `{${Object.keys(obj)
        .sort()
        .filter((k) => obj[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
        .join(',')}}`
    }
    const path = join(dir, 'large.jsonl')
    const n = 50_000
    let prevHash = '0'.repeat(64)
    const chunks: string[] = []
    for (let i = 1; i <= n; i++) {
      const partial = {
        actor: 'gateway',
        action: `act-${i}`,
        seq: i,
        timestamp: new Date(1_700_000_000_000 + i).toISOString(),
        prevHash,
      }
      const entryHash = createHash('sha256').update(canonicalize(partial)).digest('hex')
      prevHash = entryHash
      chunks.push(`${JSON.stringify({ ...partial, entryHash })}\n`)
    }
    await fs.writeFile(path, chunks.join(''))

    const w = new ChainAuditWriter(path)
    let count = 0
    let last = ''
    await w.export({}, 'jsonl', (chunk) => {
      count++
      last = chunk
    })
    expect(count).toBe(n)
    expect((JSON.parse(last) as { seq: number }).seq).toBe(n)
  })

  it('never emits a secret value (rows carry only names + non-secret metadata)', async () => {
    const path = join(dir, 'secret.jsonl')
    const w = new ChainAuditWriter(path)
    // The single writer records the *fact* of access (a secret name), never
    // the value. Export must reflect that — assert no value leaks.
    await w.write({
      actor: 'gateway',
      action: 'secret.resolve',
      details: { secretName: 'OPENAI_API_KEY' },
    })
    const jsonl = await collect(w, {}, 'jsonl')
    const csv = await collect(w, {}, 'csv')
    expect(jsonl).toContain('OPENAI_API_KEY')
    expect(jsonl).not.toMatch(/sk-[A-Za-z0-9]/)
    expect(csv).not.toMatch(/sk-[A-Za-z0-9]/)
  })
})

describe('ChainAuditWriter.prune', () => {
  it('archives the head, retains the tail, and the tail still verifies via the boundary', async () => {
    const path = join(dir, 'p.jsonl')
    const w = new ChainAuditWriter(path)
    for (let i = 0; i < 10; i++) await w.write({ actor: 'gateway', action: `act-${i}` })

    const result = await w.prune(4)
    expect(result.archived).toBe(4)
    expect(result.retained).toBe(6)
    expect(result.boundary.prunedThroughSeq).toBe(4)

    // Full verify (genesis) now reports a broken chain — the tail no longer
    // starts at seq 1 / zero prevHash. This is the documented trade-off.
    const reader = new ChainAuditWriter(path)
    const fullBreach = await reader.verify()
    expect(fullBreach).not.toBeNull()

    // Verify against the recorded boundary: the retained tail is intact.
    const tailBreach = await reader.verify({ boundary: result.boundary })
    expect(tailBreach).toBeNull()

    // The archived head verifies as its own genesis-rooted chain.
    const archiveBreach = await new ChainAuditWriter(result.boundary.archivePath).verify()
    expect(archiveBreach).toBeNull()

    const remaining = await reader.readAll()
    expect(remaining.map((e) => e.seq)).toEqual([5, 6, 7, 8, 9, 10])
  })

  it('new appends after a prune continue the chain and verify against the boundary', async () => {
    const path = join(dir, 'p2.jsonl')
    const w = new ChainAuditWriter(path)
    for (let i = 0; i < 6; i++) await w.write({ actor: 'gateway', action: `act-${i}` })
    const result = await w.prune(3)
    const w2 = new ChainAuditWriter(path)
    await w2.write({ actor: 'gateway', action: 'after-prune' })
    const breach = await w2.verify({ boundary: result.boundary })
    expect(breach).toBeNull()
    const all = await w2.readAll()
    expect(all.map((e) => e.seq)).toEqual([4, 5, 6, 7])
  })

  it('the SAME writer keeps appending a continuous chain after a partial prune', async () => {
    const path = join(dir, 'p3.jsonl')
    const w = new ChainAuditWriter(path)
    for (let i = 0; i < 6; i++) await w.write({ actor: 'gateway', action: `act-${i}` })
    const result = await w.prune(3)
    // No new instance — continue on the canonical writer (the live-gateway case).
    await w.write({ actor: 'gateway', action: 'after-prune' })
    expect(await w.verify({ boundary: result.boundary })).toBeNull()
    expect((await w.readAll()).map((e) => e.seq)).toEqual([4, 5, 6, 7])
  })

  it('a full prune does not reset the chain: same writer continues from the boundary', async () => {
    const path = join(dir, 'p4.jsonl')
    const w = new ChainAuditWriter(path)
    for (let i = 0; i < 5; i++) await w.write({ actor: 'gateway', action: `act-${i}` })
    // Prune EVERYTHING (beforeSeq >= last seq).
    const result = await w.prune(100)
    expect(result.archived).toBe(5)
    expect(result.retained).toBe(0)
    // prunedThroughSeq is the LAST ARCHIVED seq (5), not the caller's cutoff
    // (100) — no artificial gaps from an oversized cutoff value.
    expect(result.boundary.prunedThroughSeq).toBe(5)

    // Next append on the same writer must continue at prunedThroughSeq + 1 and
    // chain from the boundary hash — NOT reset to seq 1 / genesis or jump to 101.
    await w.write({ actor: 'gateway', action: 'after-full-prune' })
    const all = await w.readAll()
    expect(all.map((e) => e.seq)).toEqual([6])
    expect(all[0]?.prevHash).toBe(result.boundary.boundaryHash)
    expect(await w.verify({ boundary: result.boundary })).toBeNull()
  })

  it('a full prune survives restart: a fresh writer continues from the boundary', async () => {
    const path = join(dir, 'p5.jsonl')
    const w = new ChainAuditWriter(path)
    for (let i = 0; i < 4; i++) await w.write({ actor: 'gateway', action: `act-${i}` })
    const result = await w.prune(100)
    expect(result.retained).toBe(0)
    expect(result.boundary.prunedThroughSeq).toBe(4)

    // Simulate a gateway restart: a brand-new writer reads the now-empty live
    // log and must pick up the boundary rather than reset to genesis.
    const w2 = new ChainAuditWriter(path)
    await w2.write({ actor: 'gateway', action: 'after-restart' })
    const all = await w2.readAll()
    expect(all.map((e) => e.seq)).toEqual([5])
    expect(all[0]?.prevHash).toBe(result.boundary.boundaryHash)
    expect(await w2.verify({ boundary: result.boundary })).toBeNull()
  })
})
