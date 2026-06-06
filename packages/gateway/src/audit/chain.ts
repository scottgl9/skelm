import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { AuditEvent, AuditWriter } from '@skelm/core'

/**
 * Append-only, hash-chained audit log written as JSON-Lines. Each entry
 * carries the SHA-256 hash of the previous entry's `entryHash`, forming a
 * tamper-evident chain that `verifyChain()` can walk end-to-end.
 *
 * Single-writer: callers acquire the gateway lockfile (planning/21) before
 * constructing the writer; running two ChainAuditWriter instances against
 * the same path will corrupt the chain.
 *
 * No secret values flow through the writer — callers pass names only.
 */
export interface ChainEntry extends AuditEvent {
  /** Sequence number, 1-based. */
  seq: number
  /** ISO-8601 timestamp the writer assigned. */
  timestamp: string
  /** Hex-encoded SHA-256 of the previous entry's entryHash, or '0'.repeat(64) for seq 1. */
  prevHash: string
  /** Hex-encoded SHA-256 of the canonical JSON encoding of this entry minus entryHash. */
  entryHash: string
}

export class ChainAuditWriter implements AuditWriter {
  private lastHash: string | null = null
  private nextSeq = 1
  private initPromise: Promise<void> | null = null
  // Serializes concurrent write() calls so seq/prevHash are assigned in append
  // order, and a failed append leaves in-memory state untouched for retry.
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async write(event: AuditEvent): Promise<void> {
    await this.ensureInitialized()
    const previous = this.writeQueue
    let release!: () => void
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await previous.catch(() => {})
      const seq = this.nextSeq
      const timestamp = event.timestamp ?? new Date().toISOString()
      const prevHash = this.lastHash ?? '0'.repeat(64)
      const partial: Omit<ChainEntry, 'entryHash'> = {
        ...event,
        seq,
        timestamp,
        prevHash,
      }
      const entryHash = hashCanonical(partial)
      const entry: ChainEntry = { ...partial, entryHash }
      const fh = await fs.open(this.path, 'a')
      try {
        await fh.appendFile(`${JSON.stringify(entry)}\n`)
        await fh.sync()
      } finally {
        await fh.close()
      }
      this.lastHash = entryHash
      this.nextSeq = seq + 1
    } finally {
      release()
    }
  }

  async readAll(): Promise<ChainEntry[]> {
    try {
      const raw = await fs.readFile(this.path, 'utf8')
      return raw
        .split(/\r?\n/)
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as ChainEntry)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  /** Walk the chain, verifying every prevHash + entryHash. Returns null on success. */
  async verify(): Promise<{ seq: number; reason: string } | null> {
    const entries = await this.readAll()
    let prev = '0'.repeat(64)
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] as ChainEntry
      if (e.seq !== i + 1) return { seq: e.seq, reason: 'out-of-order seq' }
      if (e.prevHash !== prev) return { seq: e.seq, reason: 'broken chain' }
      const { entryHash, ...rest } = e
      const recomputed = hashCanonical(rest)
      if (recomputed !== entryHash) return { seq: e.seq, reason: 'tampered entry' }
      prev = entryHash
    }
    return null
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initPromise === null) {
      this.initPromise = this.doInitialize()
    }
    return this.initPromise
  }

  private async doInitialize(): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true })
    const fh = await fs.open(this.path, 'a', 0o600)
    await fh.close()
    await fs.chmod(this.path, 0o600)
    const existing = await this.readAll()
    if (existing.length > 0) {
      const last = existing[existing.length - 1] as ChainEntry
      this.lastHash = last.entryHash
      this.nextSeq = last.seq + 1
    }
  }
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}

/**
 * Canonical JSON: stable key order, no whitespace, undefined fields omitted.
 * Stable across Node versions because JSON.stringify is deterministic for
 * objects with sorted keys and primitive leaves.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(',')}}`
}
