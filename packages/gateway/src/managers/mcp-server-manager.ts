import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import type { SkelmConfigMcpServerEntry } from '@skelm/core'

export type McpServerStatus = 'stopped' | 'starting' | 'running' | 'crashed'

export interface McpServerHandle {
  id: string
  transport: 'stdio' | 'http' | 'sse'
  status: McpServerStatus
  /** For stdio: the spawned child process. For http/sse: undefined. */
  process?: ChildProcessWithoutNullStreams | undefined
  /** For http/sse: the configured URL. */
  url?: string | undefined
  pid?: number | undefined
  restarts: number
  lastError?: string | undefined
}

export interface McpServerManagerOptions {
  /** Backoff schedule (ms) — used cyclically for successive crashes. */
  backoffMs?: readonly number[]
  /** Stop restarting after this many consecutive failures (per server). Default 5. */
  maxRestarts?: number
}

const DEFAULT_BACKOFF = [200, 500, 1_000, 2_500, 5_000] as const

/**
 * Supervises MCP servers declared in skelm.config.ts. stdio servers are
 * spawned as children of the gateway process; http/sse entries are tracked
 * as URL handles only (no supervision needed). Crashes trigger an
 * exponential backoff restart up to `maxRestarts` consecutive failures,
 * after which the server is left in `crashed` and only `restart()` brings
 * it back.
 */
export class McpServerManager {
  private handles: Map<string, McpServerHandle> = new Map()
  private restartTimers: Map<string, NodeJS.Timeout> = new Map()
  private stopping = false

  constructor(private readonly opts: McpServerManagerOptions = {}) {}

  list(): McpServerHandle[] {
    return Array.from(this.handles.values())
  }

  get(id: string): McpServerHandle | undefined {
    return this.handles.get(id)
  }

  async startAll(entries: readonly SkelmConfigMcpServerEntry[]): Promise<void> {
    this.stopping = false
    await Promise.all(entries.map((e) => this.start(e)))
  }

  async start(entry: SkelmConfigMcpServerEntry): Promise<void> {
    const existing = this.handles.get(entry.id)
    if (existing && existing.status === 'running') return

    if (entry.transport === 'http' || entry.transport === 'sse') {
      this.handles.set(entry.id, {
        id: entry.id,
        transport: entry.transport,
        status: 'running',
        ...(entry.url !== undefined && { url: entry.url }),
        restarts: 0,
      })
      return
    }

    if (entry.command === undefined) {
      throw new Error(`mcp server ${entry.id}: stdio transport requires command`)
    }
    this.spawnStdio(entry, existing?.restarts ?? 0)
  }

  async stop(id: string): Promise<void> {
    const t = this.restartTimers.get(id)
    if (t !== undefined) {
      clearTimeout(t)
      this.restartTimers.delete(id)
    }
    const handle = this.handles.get(id)
    if (handle === undefined) return
    if (handle.process !== undefined) {
      handle.process.kill('SIGTERM')
    }
    handle.status = 'stopped'
  }

  async stopAll(): Promise<void> {
    this.stopping = true
    for (const id of Array.from(this.handles.keys())) {
      await this.stop(id)
    }
  }

  async restart(entry: SkelmConfigMcpServerEntry): Promise<void> {
    await this.stop(entry.id)
    this.handles.delete(entry.id)
    await this.start(entry)
  }

  private spawnStdio(entry: SkelmConfigMcpServerEntry, restartsSoFar: number): void {
    const env = { ...process.env, ...(entry.env ?? {}) }
    const command = entry.command as string
    const child = spawn(command, [...(entry.args ?? [])], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const handle: McpServerHandle = {
      id: entry.id,
      transport: 'stdio',
      status: 'starting',
      process: child,
      pid: child.pid ?? undefined,
      restarts: restartsSoFar,
    }
    this.handles.set(entry.id, handle)

    child.once('spawn', () => {
      handle.status = 'running'
    })
    child.once('exit', (code, signal) => {
      const reason = signal !== null ? `signal=${signal}` : `code=${code}`
      handle.lastError = reason
      handle.status = 'crashed'
      handle.process = undefined
      if (this.stopping) return
      const max = this.opts.maxRestarts ?? 5
      if (handle.restarts >= max) return
      const schedule = this.opts.backoffMs ?? DEFAULT_BACKOFF
      const delay = schedule[Math.min(handle.restarts, schedule.length - 1)] ?? 5_000
      handle.restarts += 1
      const timer = setTimeout(() => {
        this.restartTimers.delete(entry.id)
        if (this.stopping) return
        this.spawnStdio(entry, handle.restarts)
      }, delay)
      timer.unref?.()
      this.restartTimers.set(entry.id, timer)
    })
    child.once('error', (err) => {
      handle.lastError = err.message
    })
  }
}
