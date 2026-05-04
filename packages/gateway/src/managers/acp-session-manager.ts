import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

export type AcpSessionState = 'active' | 'paused' | 'expired'

export interface AcpSession {
  id: string
  agentId: string
  /** ISO-8601. */
  createdAt: string
  lastSeenAt: string
  state: AcpSessionState
  /** Free-form metadata persisted alongside the session (e.g. agent-specific handle). */
  metadata: Readonly<Record<string, unknown>>
}

export interface CreateSessionOptions {
  agentId: string
  metadata?: Readonly<Record<string, unknown>>
}

export interface AcpSessionManagerOptions {
  /** File the manager persists sessions to (JSON). Defaults to <stateDir>/acp-sessions.json. */
  storePath: string
  /** Sessions whose lastSeenAt exceeds this many ms before reconcile() are marked expired. */
  expireAfterMs?: number
}

/**
 * Tracks ACP sessions for resident agents. Persists state to a JSON file
 * so sessions survive gateway restarts (`reconcile()` re-reads the file at
 * start; sessions older than `expireAfterMs` are marked expired).
 *
 * Ephemeral agents do not use this manager — their per-invocation handle
 * dies with the process.
 */
export class AcpSessionManager {
  private sessions: Map<string, AcpSession> = new Map()
  private loaded = false

  constructor(private readonly opts: AcpSessionManagerOptions) {}

  async reconcile(): Promise<void> {
    await this.loadFromDisk()
    const cutoff =
      this.opts.expireAfterMs !== undefined ? Date.now() - this.opts.expireAfterMs : null
    if (cutoff !== null) {
      for (const s of this.sessions.values()) {
        if (Date.parse(s.lastSeenAt) < cutoff && s.state !== 'expired') {
          this.sessions.set(s.id, { ...s, state: 'expired' })
        }
      }
      await this.persist()
    }
  }

  list(): AcpSession[] {
    return Array.from(this.sessions.values())
  }

  get(id: string): AcpSession | undefined {
    return this.sessions.get(id)
  }

  async create(opts: CreateSessionOptions): Promise<AcpSession> {
    await this.ensureLoaded()
    const now = new Date().toISOString()
    const session: AcpSession = {
      id: cryptoId(),
      agentId: opts.agentId,
      createdAt: now,
      lastSeenAt: now,
      state: 'active',
      metadata: Object.freeze({ ...(opts.metadata ?? {}) }),
    }
    this.sessions.set(session.id, session)
    await this.persist()
    return session
  }

  async touch(id: string): Promise<AcpSession | undefined> {
    await this.ensureLoaded()
    const s = this.sessions.get(id)
    if (s === undefined) return undefined
    const updated: AcpSession = { ...s, lastSeenAt: new Date().toISOString() }
    this.sessions.set(id, updated)
    await this.persist()
    return updated
  }

  async resume(id: string): Promise<AcpSession | undefined> {
    await this.ensureLoaded()
    const s = this.sessions.get(id)
    if (s === undefined) return undefined
    if (s.state === 'expired') return undefined
    const updated: AcpSession = { ...s, state: 'active', lastSeenAt: new Date().toISOString() }
    this.sessions.set(id, updated)
    await this.persist()
    return updated
  }

  async terminate(id: string): Promise<boolean> {
    await this.ensureLoaded()
    if (!this.sessions.has(id)) return false
    this.sessions.delete(id)
    await this.persist()
    return true
  }

  /**
   * Drop sessions that match the predicate. Returns the ids removed. Used by
   * `skelm gateway prune-sessions` and the periodic compactor for
   * long-running gateways. Common usage:
   *
   *   await mgr.prune({ expired: true })
   *   await mgr.prune({ olderThanMs: 30 * 24 * 3600_000 })
   *
   * Either filter, or both, or pass a custom matcher().
   */
  async prune(opts: {
    expired?: boolean
    olderThanMs?: number
    matcher?: (session: AcpSession) => boolean
  } = {}): Promise<readonly string[]> {
    await this.ensureLoaded()
    const now = Date.now()
    const removed: string[] = []
    for (const [id, s] of this.sessions.entries()) {
      let drop = false
      if (opts.expired === true && s.state === 'expired') drop = true
      if (
        !drop &&
        opts.olderThanMs !== undefined &&
        Date.parse(s.lastSeenAt) < now - opts.olderThanMs
      ) {
        drop = true
      }
      if (!drop && opts.matcher !== undefined && opts.matcher(s)) drop = true
      if (drop) {
        this.sessions.delete(id)
        removed.push(id)
      }
    }
    if (removed.length > 0) await this.persist()
    return removed
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.loadFromDisk()
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(this.opts.storePath, 'utf8')
      const parsed = JSON.parse(raw) as AcpSession[]
      this.sessions = new Map(parsed.map((s) => [s.id, s]))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      this.sessions = new Map()
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await fs.mkdir(dirname(this.opts.storePath), { recursive: true })
    const arr = Array.from(this.sessions.values())
    await fs.writeFile(this.opts.storePath, JSON.stringify(arr, null, 2))
  }
}

export function defaultAcpSessionStorePath(stateDir: string): string {
  return join(stateDir, 'acp-sessions.json')
}

function cryptoId(): string {
  return globalThis.crypto.randomUUID()
}
