import { createHash } from 'node:crypto'
import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import type { AuditEvent, AuditFilter, AuditWriter } from '@skelm/core'

/** Output formats for {@link ChainAuditWriter.export}. */
export type AuditExportFormat = 'jsonl' | 'csv'

/**
 * Records where a prune cut the chain. Persisted next to the audit log so the
 * retained tail can still be verified after its head was archived: the tail's
 * first entry no longer chains from `'0'.repeat(64)`, it chains from the last
 * archived entry's `entryHash`. Without this boundary a full-chain `verify()`
 * of a pruned log would (correctly) report a broken chain.
 */
export interface PruneBoundary {
  /** seq of the last entry that was archived (i.e. the retained tail starts at prunedThroughSeq + 1). */
  prunedThroughSeq: number
  /** entryHash of the last archived entry — the prevHash the retained tail must chain from. */
  boundaryHash: string
  /** Absolute path of the archive segment the pruned head was written to. */
  archivePath: string
  /** ISO-8601 timestamp the prune ran. */
  prunedAt: string
}

export interface PruneResult {
  /** Number of entries moved to the archive segment. */
  archived: number
  /** Number of entries kept in the live log. */
  retained: number
  boundary: PruneBoundary
}

/**
 * Audit writers that can prune their own backing log. Pruning MUST run on the
 * canonical writer instance (not a sibling against the same path) so it both
 * serializes against concurrent writes and refreshes that writer's in-memory
 * chain state. The gateway exposes this via the enforcement audit writer so the
 * prune route never constructs a second writer.
 */
export interface PrunableAuditWriter {
  prune(beforeSeq: number): Promise<PruneResult>
}

/** Runtime capability check for {@link PrunableAuditWriter}. */
export function isPrunableAuditWriter(writer: unknown): writer is PrunableAuditWriter {
  return (
    writer !== null &&
    typeof writer === 'object' &&
    typeof (writer as PrunableAuditWriter).prune === 'function'
  )
}

/** Stable CSV column order for {@link ChainAuditWriter.export}. */
const CSV_COLUMNS = [
  'seq',
  'timestamp',
  'actor',
  'action',
  'runId',
  'prevHash',
  'entryHash',
  'details',
] as const

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
      if (!matchesFilter(entry, filter, sinceTs, untilTs)) continue
      window.push(entry)
      if (window.length > limit) window.shift()
    }
    return window
  }

  /**
   * Stream the log to `sink` in the requested format, applying the same
   * filters as {@link list} but WITHOUT a default/tail limit — export is the
   * full filtered history. Each line is written as it streams past, so memory
   * stays O(1) regardless of log size; the same streaming reader the bounded
   * `list` uses backs this, so the no-materialize guarantee is preserved.
   *
   * Audit rows carry only names + structured non-secret metadata (the single
   * writer never records secret values), so neither format can leak a secret.
   */
  async export(
    filter: AuditFilter,
    format: AuditExportFormat,
    sink: (chunk: string) => void | Promise<void>,
  ): Promise<void> {
    const sinceTs = filter.since !== undefined ? Date.parse(filter.since) : null
    const untilTs = filter.until !== undefined ? Date.parse(filter.until) : null
    if (format === 'csv') {
      await sink(`${CSV_COLUMNS.join(',')}\n`)
    }
    for await (const entry of this.streamEntries()) {
      if (!matchesFilter(entry, filter, sinceTs, untilTs)) continue
      await sink(format === 'csv' ? toCsvRow(entry) : `${JSON.stringify(entry)}\n`)
    }
  }

  /**
   * Drop the head of the log: archive every entry with `seq <= beforeSeq` to a
   * sibling segment file, rewrite the live log to the retained tail, and
   * persist a {@link PruneBoundary} so the tail still verifies.
   *
   * Chain-verify implication: after a prune, the retained tail's first entry
   * chains from the last archived `entryHash`, not from `'0'.repeat(64)`. A
   * full `verify()` would therefore report a broken chain — callers must pass
   * the recorded boundary (`verify({ boundary })`) to verify the retained tail,
   * and verify the archived segment separately. Pruning is destructive to the
   * single end-to-end chain by design; the boundary keeps each half verifiable.
   */
  async prune(beforeSeq: number): Promise<PruneResult> {
    await this.ensureInitialized()
    const previous = this.writeQueue
    let release!: () => void
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await previous.catch(() => {})
      const prunedAt = new Date().toISOString()
      const archivePath = `${this.path}.archive.${prunedAt.replace(/[:.]/g, '-')}.jsonl`
      const tailPath = `${this.path}.prune-tail`
      const archive = createWriteStream(archivePath, { mode: 0o600 })
      const tail = createWriteStream(tailPath, { mode: 0o600 })
      let archived = 0
      let retained = 0
      let boundaryHash = '0'.repeat(64)
      let lastRetainedSeq = 0
      let lastRetainedHash: string | null = null
      try {
        for await (const entry of this.streamEntries()) {
          const line = `${JSON.stringify(entry)}\n`
          if (entry.seq <= beforeSeq) {
            if (!archive.write(line)) await drain(archive)
            archived++
            boundaryHash = entry.entryHash
          } else {
            if (!tail.write(line)) await drain(tail)
            retained++
            lastRetainedSeq = entry.seq
            lastRetainedHash = entry.entryHash
          }
        }
      } finally {
        await endStream(archive)
        await endStream(tail)
      }
      await fs.rename(tailPath, this.path)
      await fs.chmod(this.path, 0o600)
      const boundary: PruneBoundary = {
        prunedThroughSeq: beforeSeq,
        boundaryHash,
        archivePath,
        prunedAt,
      }
      await fs.writeFile(`${this.path}.prune-boundary.json`, `${JSON.stringify(boundary)}\n`, {
        mode: 0o600,
      })
      // Refresh in-memory state so the SAME writer keeps appending a continuous
      // chain after the file was rewritten. With a retained tail, continue from
      // its last entry; with an empty tail (everything pruned), continue from
      // the prune boundary so the next entry is seq = prunedThroughSeq + 1 with
      // prevHash = boundaryHash — exactly what verify({ boundary }) expects.
      // Without this, a full prune would reset the next write to seq 1 / genesis
      // and orphan the boundary, silently breaking chain verification.
      if (retained > 0) {
        this.nextSeq = lastRetainedSeq + 1
        this.lastHash = lastRetainedHash
      } else {
        this.nextSeq = beforeSeq + 1
        this.lastHash = boundaryHash
      }
      return { archived, retained, boundary }
    } finally {
      release()
    }
  }

  /**
   * Walk the chain, verifying every prevHash + entryHash. Returns null on
   * success. Pass `boundary` to verify a retained tail whose head was pruned:
   * the first entry then must carry `seq = prunedThroughSeq + 1` and chain from
   * `boundary.boundaryHash` instead of the genesis zero hash.
   */
  async verify(opts: { boundary?: PruneBoundary } = {}): Promise<{
    seq: number
    reason: string
  } | null> {
    const boundary = opts.boundary
    let prev = boundary?.boundaryHash ?? '0'.repeat(64)
    let expectedSeq = boundary !== undefined ? boundary.prunedThroughSeq + 1 : 1
    for await (const e of this.streamEntries()) {
      if (e.seq !== expectedSeq) return { seq: e.seq, reason: 'out-of-order seq' }
      if (e.prevHash !== prev) return { seq: e.seq, reason: 'broken chain' }
      const { entryHash, ...rest } = e
      const recomputed = hashCanonical(rest)
      if (recomputed !== entryHash) return { seq: e.seq, reason: 'tampered entry' }
      prev = entryHash
      expectedSeq++
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
      return
    }
    // Live file is empty. If it was emptied by a full prune, continue from the
    // recorded boundary so a writer constructed after restart resumes the chain
    // at prunedThroughSeq + 1 chaining from boundaryHash, instead of resetting
    // to seq 1 / genesis and orphaning the boundary.
    const boundary = await this.readPruneBoundary()
    if (boundary !== null) {
      this.lastHash = boundary.boundaryHash
      this.nextSeq = boundary.prunedThroughSeq + 1
    }
  }

  /** Read the persisted prune boundary, or null when none / unreadable. */
  private async readPruneBoundary(): Promise<PruneBoundary | null> {
    try {
      const raw = await fs.readFile(`${this.path}.prune-boundary.json`, 'utf8')
      const parsed = JSON.parse(raw) as PruneBoundary
      if (typeof parsed.prunedThroughSeq === 'number' && typeof parsed.boundaryHash === 'string') {
        return parsed
      }
      return null
    } catch {
      return null
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

function matchesFilter(
  entry: ChainEntry,
  filter: AuditFilter,
  sinceTs: number | null,
  untilTs: number | null,
): boolean {
  if (filter.before !== undefined && entry.seq >= filter.before) return false
  if (filter.runId !== undefined && entry.runId !== filter.runId) return false
  if (filter.actor !== undefined && entry.actor !== filter.actor) return false
  if (filter.action !== undefined && entry.action !== filter.action) return false
  const ts = Date.parse(entry.timestamp)
  if (sinceTs !== null && ts < sinceTs) return false
  if (untilTs !== null && ts > untilTs) return false
  return true
}

function toCsvRow(entry: ChainEntry): string {
  const cells = CSV_COLUMNS.map((col) => {
    if (col === 'details') {
      return entry.details === undefined ? '' : JSON.stringify(entry.details)
    }
    const value = (entry as unknown as Record<string, unknown>)[col]
    return value === undefined ? '' : String(value)
  })
  return `${cells.map(csvEscape).join(',')}\n`
}

// RFC-4180 escaping: quote any field containing a comma, quote, or newline;
// double embedded quotes. Always returns a plain string — the canonical CSV
// shape every spreadsheet/SIEM importer accepts.
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function drain(stream: import('node:fs').WriteStream): Promise<void> {
  return new Promise((resolve) => stream.once('drain', resolve))
}

function endStream(stream: import('node:fs').WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on('error', reject)
    stream.end(() => resolve())
  })
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
