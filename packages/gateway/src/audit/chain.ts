import { createHash } from 'node:crypto'
import { promises as fs, createReadStream } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import type { AuditEvent, AuditFilter, AuditWriter } from '@skelm/core'

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

  /**
   * Stream the log line-by-line, parsing each entry, without ever holding the
   * whole file in memory. The backing file is append-only JSON-Lines, so a
   * line cursor over a read stream is O(1) memory regardless of file size — a
   * 1.5M-line log would overflow V8's max-string limit if read whole.
   */
  private async *streamEntries(): AsyncGenerator<ChainEntry> {
    // createReadStream defers ENOENT to an async 'error' event, which the
    // for-await loop surfaces as a rejection — caught below, not at open.
    const stream = createReadStream(this.path, { encoding: 'utf8' })
    try {
      const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
      for await (const line of rl) {
        if (line.length === 0) continue
        yield JSON.parse(line) as ChainEntry
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    } finally {
      stream.destroy()
    }
  }

  async readAll(): Promise<ChainEntry[]> {
    const entries: ChainEntry[] = []
    for await (const entry of this.streamEntries()) entries.push(entry)
    return entries
  }

  /**
   * Filtered, bounded read. Returns at most `limit` (default 500, max 5000)
   * entries, defaulting to the most recent (tail). Memory stays O(limit): a
   * ring buffer keeps only the trailing window as entries stream past.
   */
  async list(filter: AuditFilter = {}): Promise<readonly ChainEntry[]> {
    const sinceTs = filter.since !== undefined ? Date.parse(filter.since) : null
    const untilTs = filter.until !== undefined ? Date.parse(filter.until) : null
    const limit = Math.max(1, Math.min(5000, filter.limit ?? 500))
    const window: ChainEntry[] = []
    for await (const entry of this.streamEntries()) {
      if (filter.before !== undefined && entry.seq >= filter.before) continue
      if (filter.runId !== undefined && entry.runId !== filter.runId) continue
      if (filter.actor !== undefined && entry.actor !== filter.actor) continue
      if (filter.action !== undefined && entry.action !== filter.action) continue
      const ts = Date.parse(entry.timestamp)
      if (sinceTs !== null && ts < sinceTs) continue
      if (untilTs !== null && ts > untilTs) continue
      window.push(entry)
      if (window.length > limit) window.shift()
    }
    return window
  }

  /** Walk the chain, verifying every prevHash + entryHash. Returns null on success. */
  async verify(): Promise<{ seq: number; reason: string } | null> {
    let prev = '0'.repeat(64)
    let i = 0
    for await (const e of this.streamEntries()) {
      if (e.seq !== i + 1) return { seq: e.seq, reason: 'out-of-order seq' }
      if (e.prevHash !== prev) return { seq: e.seq, reason: 'broken chain' }
      const { entryHash, ...rest } = e
      const recomputed = hashCanonical(rest)
      if (recomputed !== entryHash) return { seq: e.seq, reason: 'tampered entry' }
      prev = entryHash
      i++
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
    const last = await this.readLastEntry()
    if (last !== null) {
      this.lastHash = last.entryHash
      this.nextSeq = last.seq + 1
    }
  }

  /**
   * Read only the last entry from the audit log by seeking backwards from EOF.
   * Avoids loading the entire file into memory when the log is large.
   */
  private async readLastEntry(): Promise<ChainEntry | null> {
    let fh: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      fh = await fs.open(this.path, 'r')
      const { size } = await fh.stat()
      if (size === 0) return null
      // Read backwards in 4KiB chunks until we find a complete JSON line.
      const chunkSize = 4096
      let pos = size
      let tail = ''
      while (pos > 0) {
        const readSize = Math.min(chunkSize, pos)
        pos -= readSize
        const buf = Buffer.alloc(readSize)
        await fh.read(buf, 0, readSize, pos)
        tail = buf.toString('utf8') + tail
        // Find the last complete line (not the trailing newline).
        const trimmed = tail.trimEnd()
        const nl = trimmed.lastIndexOf('\n')
        const candidate = nl === -1 ? trimmed : trimmed.slice(nl + 1)
        if (candidate.length > 0) {
          try {
            return JSON.parse(candidate) as ChainEntry
          } catch {
            // incomplete chunk — read more
          }
        }
      }
      return null
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    } finally {
      await fh?.close()
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
