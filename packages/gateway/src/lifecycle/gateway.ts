import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_CONFIG, type SkelmConfig } from '@skelm/core'
import {
  AgentRegistry,
  McpServerRegistry,
  SkillRegistry,
  WorkflowRegistry,
} from '../registries/index.js'
import { type DiscoveryRecord, removeDiscovery, writeDiscovery } from './discovery.js'
import { type LockfileContents, acquireLockfile, releaseLockfile } from './lockfile.js'

export type GatewayState = 'stopped' | 'starting' | 'running' | 'paused' | 'stopping'

export interface GatewayOptions {
  /** Directory holding `gateway.lock` and `gateway.json`. Defaults to `~/.skelm`. */
  stateDir?: string
  /** Project root used to resolve registry globs. Defaults to `process.cwd()`. */
  projectRoot?: string
  /** Loaded config (with defaults applied). Defaults to DEFAULT_CONFIG. */
  config?: SkelmConfig
  /** Bound URL advertised in the discovery file. Phase 2 placeholder until HTTP is wired in. */
  url?: string
  /** Optional bearer token written into the discovery file. */
  token?: string
  /** Install OS signal handlers (SIGTERM/SIGINT/SIGHUP). Disabled in tests by default. */
  installSignalHandlers?: boolean
  /** Enable FS watching on the workflow / skill registries. Defaults to true. */
  watchRegistries?: boolean
}

export interface GatewayRegistries {
  workflows: WorkflowRegistry
  skills: SkillRegistry
  agents: AgentRegistry
  mcpServers: McpServerRegistry
}

/**
 * Long-running gateway lifecycle. Phase 2 wired the lockfile, discovery
 * file, and signal handlers; Phase 3 adds config-driven registries with
 * FS watching for workflows and skills. Subsequent phases inject
 * enforcement, audit, HTTP listener, supervisors, and the scheduler.
 */
export class Gateway {
  readonly stateDir: string
  readonly projectRoot: string
  readonly lockfilePath: string
  readonly discoveryPath: string

  private state: GatewayState = 'stopped'
  private lockfile: LockfileContents | null = null
  private discovery: DiscoveryRecord | null = null
  private signalsAttached = false
  private readonly handlers: Map<NodeJS.Signals, () => void> = new Map()
  private config: SkelmConfig
  private registriesInternal: GatewayRegistries | null = null

  constructor(private readonly options: GatewayOptions = {}) {
    this.stateDir = options.stateDir ?? join(homedir(), '.skelm')
    this.projectRoot = resolve(options.projectRoot ?? process.cwd())
    this.lockfilePath = join(this.stateDir, 'gateway.lock')
    this.discoveryPath = join(this.stateDir, 'gateway.json')
    this.config = options.config ?? DEFAULT_CONFIG
  }

  getState(): GatewayState {
    return this.state
  }

  getDiscovery(): DiscoveryRecord | null {
    return this.discovery
  }

  getConfig(): SkelmConfig {
    return this.config
  }

  /** Throws if accessed before start() succeeds or after stop(). */
  get registries(): GatewayRegistries {
    if (this.registriesInternal === null) {
      throw new Error('gateway registries are not available — start() the gateway first')
    }
    return this.registriesInternal
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
      this.registriesInternal = await this.buildRegistries()
      if (this.options.installSignalHandlers) this.attachSignals()
      this.state = 'running'
    } catch (err) {
      this.state = 'stopped'
      this.lockfile = null
      this.discovery = null
      this.registriesInternal = null
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
   * Hot-reload registries (and, in later phases, config + plugins) without
   * dropping in-flight runs. The default reload re-scans FS-backed
   * registries and re-applies the (unchanged) config-backed ones.
   */
  async reload(nextConfig?: SkelmConfig): Promise<void> {
    if (this.state !== 'running' && this.state !== 'paused') {
      throw new Error(`cannot reload gateway in state ${this.state}`)
    }
    if (nextConfig !== undefined) {
      this.config = nextConfig
    }
    if (this.registriesInternal !== null) {
      const r = this.registriesInternal
      r.agents.setAgents(this.config.registries?.agents ?? [])
      r.mcpServers.setServers(this.config.registries?.mcpServers ?? [])
      await Promise.all([
        r.workflows.refresh(),
        r.skills.refresh(),
        r.agents.refresh(),
        r.mcpServers.refresh(),
      ])
    }
  }

  async stop(_options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.state === 'stopped') return
    this.state = 'stopping'
    try {
      this.detachSignals()
      if (this.registriesInternal !== null) {
        await Promise.all([
          this.registriesInternal.workflows.close(),
          this.registriesInternal.skills.close(),
          this.registriesInternal.agents.close(),
          this.registriesInternal.mcpServers.close(),
        ])
      }
      await removeDiscovery(this.discoveryPath)
      await releaseLockfile(this.lockfilePath)
    } finally {
      this.state = 'stopped'
      this.lockfile = null
      this.discovery = null
      this.registriesInternal = null
    }
  }

  private async buildRegistries(): Promise<GatewayRegistries> {
    const watch = this.options.watchRegistries ?? true
    const workflows = new WorkflowRegistry({
      projectRoot: this.projectRoot,
      glob: this.config.registries?.workflows?.glob ?? 'workflows/**/*.workflow.ts',
      watch,
    })
    const skills = new SkillRegistry({
      projectRoot: this.projectRoot,
      glob: this.config.registries?.skills?.glob ?? 'skills/**/SKILL.md',
      watch,
    })
    const agents = AgentRegistry.fromOptions({
      agents: this.config.registries?.agents ?? [],
    })
    const mcpServers = McpServerRegistry.fromOptions({
      servers: this.config.registries?.mcpServers ?? [],
    })
    await workflows.start()
    await skills.start()
    await agents.refresh()
    await mcpServers.refresh()
    return { workflows, skills, agents, mcpServers }
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
