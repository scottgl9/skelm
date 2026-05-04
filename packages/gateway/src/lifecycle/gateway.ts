import { homedir } from 'node:os'
import { join } from 'node:path'
import { type DiscoveryRecord, removeDiscovery, writeDiscovery } from './discovery.js'
import { type LockfileContents, acquireLockfile, releaseLockfile } from './lockfile.js'

export type GatewayState = 'stopped' | 'starting' | 'running' | 'paused' | 'stopping'

export interface GatewayOptions {
  /** Directory holding `gateway.lock` and `gateway.json`. Defaults to `~/.skelm`. */
  stateDir?: string
  /** Bound URL advertised in the discovery file. Phase 2 placeholder until HTTP is wired in. */
  url?: string
  /** Optional bearer token written into the discovery file. */
  token?: string
  /** Install OS signal handlers (SIGTERM/SIGINT/SIGHUP). Disabled in tests by default. */
  installSignalHandlers?: boolean
}

/**
 * Long-running gateway lifecycle. Phase 2 wires only the lockfile, discovery
 * file, signal handlers, and state transitions. Subsequent phases inject
 * registries, enforcement, audit, HTTP listener, and scheduler.
 */
export class Gateway {
  readonly stateDir: string
  readonly lockfilePath: string
  readonly discoveryPath: string

  private state: GatewayState = 'stopped'
  private lockfile: LockfileContents | null = null
  private discovery: DiscoveryRecord | null = null
  private signalsAttached = false
  private readonly handlers: Map<NodeJS.Signals, () => void> = new Map()

  constructor(private readonly options: GatewayOptions = {}) {
    this.stateDir = options.stateDir ?? join(homedir(), '.skelm')
    this.lockfilePath = join(this.stateDir, 'gateway.lock')
    this.discoveryPath = join(this.stateDir, 'gateway.json')
  }

  getState(): GatewayState {
    return this.state
  }

  getDiscovery(): DiscoveryRecord | null {
    return this.discovery
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped') {
      throw new Error(`cannot start gateway in state ${this.state}`)
    }
    this.state = 'starting'
    try {
      this.lockfile = await acquireLockfile(this.lockfilePath)
      this.discovery = {
        pid: process.pid,
        url: this.options.url ?? 'http://127.0.0.1:4000',
        token: this.options.token,
        startedAt: this.lockfile.startedAt,
      }
      await writeDiscovery(this.discoveryPath, this.discovery)
      if (this.options.installSignalHandlers) this.attachSignals()
      this.state = 'running'
    } catch (err) {
      this.state = 'stopped'
      this.lockfile = null
      this.discovery = null
      throw err
    }
  }

  async pause(): Promise<void> {
    if (this.state !== 'running') {
      throw new Error(`cannot pause gateway in state ${this.state}`)
    }
    this.state = 'paused'
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused') {
      throw new Error(`cannot resume gateway in state ${this.state}`)
    }
    this.state = 'running'
  }

  /**
   * Hot-reload config / registries without dropping in-flight runs.
   * Phase 2 is a no-op placeholder; Phase 3+ wires registries.
   */
  async reload(): Promise<void> {
    if (this.state !== 'running' && this.state !== 'paused') {
      throw new Error(`cannot reload gateway in state ${this.state}`)
    }
  }

  async stop(_options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.state === 'stopped') return
    this.state = 'stopping'
    try {
      this.detachSignals()
      await removeDiscovery(this.discoveryPath)
      await releaseLockfile(this.lockfilePath)
    } finally {
      this.state = 'stopped'
      this.lockfile = null
      this.discovery = null
    }
  }

  private attachSignals(): void {
    if (this.signalsAttached) return
    const stop = () => {
      void this.stop().catch(() => {
        /* swallow — process is exiting */
      })
    }
    const reload = () => {
      void this.reload().catch(() => {
        /* swallow — best-effort */
      })
    }
    this.handlers.set('SIGTERM', stop)
    this.handlers.set('SIGINT', stop)
    this.handlers.set('SIGHUP', reload)
    for (const [sig, h] of this.handlers) process.on(sig, h)
    this.signalsAttached = true
  }

  private detachSignals(): void {
    if (!this.signalsAttached) return
    for (const [sig, h] of this.handlers) process.off(sig, h)
    this.handlers.clear()
    this.signalsAttached = false
  }
}
