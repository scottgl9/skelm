import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import type { SkelmConfigAgentEntry } from '@skelm/core'

export type CodingAgentStatus = 'stopped' | 'starting' | 'running' | 'crashed'

export interface ResidentHandle {
  kind: 'resident'
  id: string
  runtime: string
  status: CodingAgentStatus
  /** URL the supervised agent is reachable at (assigned port for spawned agents). */
  url: string
  pid?: number | undefined
  process?: ChildProcessWithoutNullStreams | undefined
  restarts: number
  lastError?: string | undefined
  /** Per-agent in-flight request count (advisory; supervisor does not enforce). */
  inflight: number
}

export interface EphemeralRun {
  id: string
  runtime: string
  pid?: number | undefined
  startedAt: string
}

export type CodingAgentHandle = ResidentHandle

export interface CodingAgentManagerOptions {
  backoffMs?: readonly number[]
  maxRestarts?: number
  /** Soft per-agent concurrency cap for ephemeral runs. Default: unlimited. */
  ephemeralConcurrency?: number
}

const DEFAULT_BACKOFF = [200, 500, 1_000, 2_500, 5_000] as const

/**
 * Supervises coding agents. Two strategies, dispatched by `lifecycle`:
 *
 * - `resident`: spawn a long-living `serve` process (e.g. `opencode serve`),
 *   monitor its lifetime, restart on crash, share the URL across runs.
 * - `ephemeral`: per-step spawn — invoked via `spawnEphemeral()`. The
 *   supervisor records the in-flight set so callers can introspect /
 *   enforce concurrency caps. The process exits when the step does.
 *
 * Existing backends (@skelm/opencode, @skelm/pi) consume the resident URL
 * via the gateway in Phase 11; until then this manager is callable
 * directly from custom embeddings.
 */
export class CodingAgentManager {
  private resident: Map<string, ResidentHandle> = new Map()
  private ephemerals: Map<string, EphemeralRun[]> = new Map()
  private restartTimers: Map<string, NodeJS.Timeout> = new Map()
  private stopping = false

  constructor(private readonly opts: CodingAgentManagerOptions = {}) {}

  list(): ResidentHandle[] {
    return Array.from(this.resident.values())
  }

  get(id: string): ResidentHandle | undefined {
    return this.resident.get(id)
  }

  ephemeralRuns(id: string): EphemeralRun[] {
    return [...(this.ephemerals.get(id) ?? [])]
  }

  async startAll(entries: readonly SkelmConfigAgentEntry[]): Promise<void> {
    this.stopping = false
    for (const entry of entries) {
      if (entry.lifecycle === 'resident') {
        await this.startResident(entry)
      }
    }
  }

  async startResident(entry: SkelmConfigAgentEntry): Promise<ResidentHandle> {
    if (entry.lifecycle !== 'resident') {
      throw new Error(`agent ${entry.id} is not a resident agent`)
    }
    const existing = this.resident.get(entry.id)
    if (existing && existing.status === 'running') return existing

    // If the user supplied a fixed URL (already-running daemon), record it.
    if (entry.url !== undefined) {
      const handle: ResidentHandle = {
        kind: 'resident',
        id: entry.id,
        runtime: entry.runtime,
        status: 'running',
        url: entry.url,
        restarts: existing?.restarts ?? 0,
        inflight: 0,
      }
      this.resident.set(entry.id, handle)
      return handle
    }

    if (entry.command === undefined) {
      throw new Error(`resident agent ${entry.id}: must supply either url or command`)
    }
    const port = await pickFreePort()
    const args = withInjectedPort(entry.args ?? [], port)
    const env = { ...process.env, ...(entry.env ?? {}), PORT: String(port) }
    const child = spawn(entry.command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const handle: ResidentHandle = {
      kind: 'resident',
      id: entry.id,
      runtime: entry.runtime,
      status: 'starting',
      url: `http://127.0.0.1:${port}`,
      pid: child.pid ?? undefined,
      process: child,
      restarts: existing?.restarts ?? 0,
      inflight: 0,
    }
    this.resident.set(entry.id, handle)

    child.once('spawn', () => {
      handle.status = 'running'
    })
    child.once('exit', (code, signal) => {
      handle.lastError = signal !== null ? `signal=${signal}` : `code=${code}`
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
        void this.startResident(entry)
      }, delay)
      timer.unref?.()
      this.restartTimers.set(entry.id, timer)
    })
    child.once('error', (err) => {
      handle.lastError = err.message
    })
    return handle
  }

  async stopResident(id: string): Promise<void> {
    const t = this.restartTimers.get(id)
    if (t !== undefined) {
      clearTimeout(t)
      this.restartTimers.delete(id)
    }
    const handle = this.resident.get(id)
    if (handle === undefined) return
    if (handle.process !== undefined) {
      handle.process.kill('SIGTERM')
    }
    handle.status = 'stopped'
  }

  async stopAll(): Promise<void> {
    this.stopping = true
    for (const id of Array.from(this.resident.keys())) {
      await this.stopResident(id)
    }
  }

  /**
   * Spawn an ephemeral coding-agent process for a single step. Returns when
   * the process exits. stdout/stderr are captured. Throws on non-zero exit.
   */
  async spawnEphemeral(
    entry: SkelmConfigAgentEntry,
    input: { prompt?: string; stdin?: string },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (entry.lifecycle !== 'ephemeral') {
      throw new Error(`agent ${entry.id} is not ephemeral`)
    }
    if (entry.command === undefined) {
      throw new Error(`ephemeral agent ${entry.id}: must supply command`)
    }
    const cap = this.opts.ephemeralConcurrency
    if (cap !== undefined && (this.ephemerals.get(entry.id)?.length ?? 0) >= cap) {
      throw new Error(`agent ${entry.id} ephemeral concurrency cap (${cap}) reached`)
    }
    const env = { ...process.env, ...(entry.env ?? {}) }
    const child = spawn(entry.command, [...(entry.args ?? [])], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const run: EphemeralRun = {
      id: `${entry.id}:${child.pid ?? 'pending'}`,
      runtime: entry.runtime,
      pid: child.pid ?? undefined,
      startedAt: new Date().toISOString(),
    }
    const list = this.ephemerals.get(entry.id) ?? []
    list.push(run)
    this.ephemerals.set(entry.id, list)

    if (input.stdin !== undefined) {
      child.stdin.write(input.stdin)
    } else if (input.prompt !== undefined) {
      child.stdin.write(input.prompt)
    }
    child.stdin.end()

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => {
      stdout += b.toString()
    })
    child.stderr.on('data', (b) => {
      stderr += b.toString()
    })

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? -1))
    })

    const after = (this.ephemerals.get(entry.id) ?? []).filter((r) => r !== run)
    this.ephemerals.set(entry.id, after)

    return { exitCode, stdout, stderr }
  }
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close()
        reject(new Error('failed to bind ephemeral port'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}

function withInjectedPort(args: readonly string[], port: number): string[] {
  // Replace any literal '${PORT}' in args with the actual port.
  return args.map((a) => a.replace('${PORT}', String(port)))
}
