import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Structured operational log entry. Distinct from audit (security records)
 * and run events (per-run telemetry) — these are gateway-process-level
 * lines: startup, route hits, auth failures, secret-resolver errors,
 * scheduler tick events, etc.
 *
 * Sensitive fields are redacted by the sink, never by the producer or the
 * consumer. That keeps the redaction policy in one place.
 */
export interface LogEntry {
  /** ISO-8601 timestamp; the sink fills this if the caller omitted. */
  readonly timestamp?: string
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly fields?: Readonly<Record<string, unknown>>
}

export interface LogSink {
  write(entry: LogEntry): void | Promise<void>
}

/** Names whose values should never appear in the log. Case-insensitive. */
const SECRET_FIELD_NAMES = new Set([
  'password',
  'token',
  'authorization',
  'apikey',
  'api_key',
  'secret',
  'cookie',
  'set-cookie',
  'bearer',
])

/** Patterns that match secret-shaped string values. Keep tight; false positives are loud. */
const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / Anthropic keys
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub PATs
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab tokens
  /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}\b/gi,
]

/** Replace secret-shaped values with "[REDACTED]". Mutates copies; never the input. */
export function redact(entry: LogEntry): LogEntry {
  const fields = entry.fields ? redactObject(entry.fields) : undefined
  return {
    ...entry,
    message: redactString(entry.message),
    ...(fields !== undefined && { fields }),
  }
}

function redactObject(obj: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELD_NAMES.has(k.toLowerCase())) {
      out[k] = '[REDACTED]'
      continue
    }
    if (typeof v === 'string') {
      out[k] = redactString(v)
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactObject(v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

function redactString(s: string): string {
  let result = s
  for (const re of SECRET_VALUE_PATTERNS) {
    result = result.replace(re, '[REDACTED]')
  }
  return result
}

/**
 * Bounded in-memory ring buffer. Cheap; suitable for `skelm logs` over a
 * short window. For long retention plus rotation, use the file sink.
 */
export class RingBufferLogSink implements LogSink {
  private readonly buf: LogEntry[]
  private head = 0
  private size = 0

  constructor(readonly capacity = 1024) {
    if (capacity < 1) throw new Error('RingBufferLogSink capacity must be >= 1')
    this.buf = new Array(capacity)
  }

  write(entry: LogEntry): void {
    const stamped: LogEntry = {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      level: entry.level,
      message: entry.message,
      ...(entry.fields !== undefined && { fields: entry.fields }),
    }
    this.buf[this.head] = redact(stamped)
    this.head = (this.head + 1) % this.capacity
    if (this.size < this.capacity) this.size++
  }

  /** Read the most recent `count` entries in oldest-to-newest order. */
  recent(count = this.size): LogEntry[] {
    const n = Math.min(count, this.size)
    const out: LogEntry[] = []
    const start = (this.head - this.size + this.capacity) % this.capacity
    for (let i = this.size - n; i < this.size; i++) {
      const idx = (start + i) % this.capacity
      const e = this.buf[idx]
      if (e !== undefined) out.push(e)
    }
    return out
  }
}

/** Append-only JSON-Lines log on disk. The simplest durable sink. */
export class FileLogSink implements LogSink {
  private queue: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  write(entry: LogEntry): Promise<void> {
    const stamped: LogEntry = {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      level: entry.level,
      message: entry.message,
      ...(entry.fields !== undefined && { fields: entry.fields }),
    }
    const redacted = redact(stamped)
    // Serialize writes through a chained promise so concurrent writers
    // don't interleave inside a single line.
    this.queue = this.queue.then(async () => {
      await fs.mkdir(dirname(this.path), { recursive: true })
      await fs.appendFile(this.path, `${JSON.stringify(redacted)}\n`)
    })
    return this.queue
  }
}

/** Fan-out to multiple sinks. Useful for "ring buffer + file" deployments. */
export class TeeLogSink implements LogSink {
  constructor(private readonly sinks: readonly LogSink[]) {}
  async write(entry: LogEntry): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.write(entry)))
  }
}
