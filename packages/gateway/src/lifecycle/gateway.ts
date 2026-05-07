import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type ApprovalGate,
  type AuditWriter,
  DEFAULT_CONFIG,
  EnvSecretResolver,
  MemoryRunStore,
  NoopAuditWriter,
  PermissionResolver,
  type RunStore,
  type SecretResolver,
  type SkelmConfig,
  SqliteRunStore,
  type NetworkPolicy,
} from '@skelm/core'
import { SuspendApprovalGate } from '../approvals/suspend-gate.js'
import { ChainAuditWriter } from '../audit/chain.js'
import { BreakpointRegistry } from '../debug/breakpoint-registry.js'
import { type SkelmServer, createServer } from '../http/index.js'
import { AcpSessionManager, defaultAcpSessionStorePath } from '../managers/acp-session-manager.js'
import { CodingAgentManager } from '../managers/coding-agent-manager.js'
import { McpServerManager } from '../managers/mcp-server-manager.js'
import {
  AgentRegistry,
  McpServerRegistry,
  SkillRegistry,
  WorkflowRegistry,
} from '../registries/index.js'
import { FileSecretResolver } from '../secrets/file-driver.js'
import { TriggerCoordinator } from '../triggers/coordinator.js'
import { createTriggerDispatcher } from '../triggers/dispatcher.js'
import {
  EgressProxy,
  InMemoryTokenPolicyStore,
  type TokenPolicyMap,
} from '../proxy/index.js'
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
  /** Override the canonical audit writer; defaults to NoopAuditWriter (Phase 5 wires the chain). */
  auditWriter?: AuditWriter
  /** Override the canonical secret resolver; defaults to env-backed (Phase 5 wires the file driver). */
  secretResolver?: SecretResolver
  /** Override the canonical approval gate; defaults to auto-approve (Phase 6 wires the suspend gate). */
  approvalGate?: ApprovalGate
  /**
   * When true, start the HTTP control surface alongside the rest of the
   * lifecycle. Defaults to false so unit tests don't bind a port; the CLI
   * sets this to true on `skelm gateway start --foreground`.
   */
  enableHttp?: boolean
  /** Bound URL the HTTP server should advertise; defaults to http://127.0.0.1:14738. */
  httpHost?: string
  httpPort?: number
  /**
   * Optional loader the HTTP /pipelines/:id route uses to import a workflow
   * module from its registered path so its graph can be serialized.
   * Production wires this to tsImport(); tests can supply a fake.
   */
  loadWorkflow?: (registryId: string, absolutePath: string) => Promise<unknown>
  /**
   * Enable the Prometheus metrics collector and the GET /metrics endpoint.
   * The collector subscribes to run-event buses passed via
   * gateway.attachMetricsBus(); the route renders the current snapshot.
   */
  enableMetrics?: boolean
  /**
   * Custom RunStore. When provided, overrides the storage config and is
   * used as-is — the gateway calls no constructor and applies no path
   * resolution. This is the integration point for callers that want a
   * Postgres-backed store, a Redis store, an in-memory store for tests,
   * or any other implementation of RunStore. Without this option, the
   * gateway constructs a SqliteRunStore at <stateDir>/runs.sqlite (or
   * the path from config.storage.runs.path if set).
   */
  runStore?: RunStore
}

export interface GatewayEnforcement {
  permissionResolver: PermissionResolver
  auditWriter: AuditWriter
  secretResolver: SecretResolver
  approvalGate: ApprovalGate
}

export interface GatewayRegistries {
  workflows: WorkflowRegistry
  skills: SkillRegistry
  agents: AgentRegistry
  mcpServers: McpServerRegistry
}

export interface GatewayManagers {
  mcp: McpServerManager
  codingAgents: CodingAgentManager
  acpSessions: AcpSessionManager
  triggers: TriggerCoordinator
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
  private enforcementInternal: GatewayEnforcement | null = null
  private managersInternal: GatewayManagers | null = null
  private runStoreInternal: RunStore | null = null
  private httpServer: SkelmServer | null = null
  private egressProxy: EgressProxy | null = null
  private tokenPolicyStore: TokenPolicyMap | null = null
  private readonly inFlightRuns = new Map<string, AbortController>()
  private readonly inFlightRunners = new Map<string, import('@skelm/core').Runner>()
  private metricsInternal: import('@skelm/metrics').MetricsCollector | null = null
  private metricsBus: import('@skelm/core').EventBus | null = null
  private readonly breakpointsInternal: import('../debug/breakpoint-registry.js').BreakpointRegistry

  constructor(private readonly options: GatewayOptions = {}) {
    this.stateDir = options.stateDir ?? join(homedir(), '.skelm')
    this.projectRoot = resolve(options.projectRoot ?? process.cwd())
    this.lockfilePath = join(this.stateDir, 'gateway.lock')
    this.discoveryPath = join(this.stateDir, 'gateway.json')
    this.config = options.config ?? DEFAULT_CONFIG
    this.breakpointsInternal = new BreakpointRegistry()
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

  /** Trust-boundary instances the gateway hands to Runners it constructs. */
  get enforcement(): GatewayEnforcement {
    if (this.enforcementInternal === null) {
      throw new Error('gateway enforcement is not available — start() the gateway first')
    }
    return this.enforcementInternal
  }

  /** The durable RunStore; constructed at start() per the storage config. */
  get runStore(): RunStore {
    if (this.runStoreInternal === null) {
      throw new Error('gateway runStore is not available — start() the gateway first')
    }
    return this.runStoreInternal
  }

  /**
   * Register an AbortController for an in-flight run so that
   * `gateway.cancel(runId)` can abort it. The dispatcher calls this when
   * it starts a run and pairs it with `unregisterRun` once the run
   * settles.
   */
  registerRun(
    runId: string,
    controller: AbortController,
    runner?: import('@skelm/core').Runner,
  ): void {
    this.inFlightRuns.set(runId, controller)
    if (runner !== undefined) this.inFlightRunners.set(runId, runner)
  }

  unregisterRun(runId: string): void {
    this.inFlightRuns.delete(runId)
    this.inFlightRunners.delete(runId)
  }

  /**
   * The Runner managing an in-flight run. Used by the HTTP layer to forward
   * resume() calls (POST /runs/:runId/resume) to the right Runner instance.
   * Returns undefined when the run is unknown or already completed.
   */
  getRunner(runId: string): import('@skelm/core').Runner | undefined {
    return this.inFlightRunners.get(runId)
  }

  /**
   * Cancel a running run by aborting its registered AbortController.
   * Returns false if the runId is not in flight (already completed,
   * never started, or unknown to the gateway).
   */
  /**
   * Returns the loader the HTTP /pipelines/:id route uses to import workflow
   * modules. undefined when no loader was configured at construction time.
   */
  getWorkflowLoader():
    | ((registryId: string, absolutePath: string) => Promise<unknown>)
    | undefined {
    return this.options.loadWorkflow
  }

  /**
   * The breakpoint registry. Operators add step ids via the /debug HTTP
   * routes; the dispatcher's beforeStep hook consults this registry to
   * decide whether to pause a step until the operator releases the run.
   */
  get breakpoints(): BreakpointRegistry {
    return this.breakpointsInternal
  }

  /**
   * The metrics collector wired to the gateway's run-event stream when
   * GatewayOptions.enableMetrics is true. Returns null when metrics are
   * disabled. The dispatcher feeds events into the bus this collector
   * subscribes to via attachMetricsBus().
   */
  get metrics(): import('@skelm/metrics').MetricsCollector | null {
    return this.metricsInternal
  }

  /**
   * Subscribe an EventBus into the metrics collector. The dispatcher calls
   * this with the per-run bus the Runner uses, so step events surface in
   * /metrics. No-ops when metrics are disabled.
   */
  attachMetricsBus(bus: import('@skelm/core').EventBus): void {
    if (this.metricsInternal === null) return
    this.metricsInternal.attach(bus)
  }

  cancel(runId: string, reason?: string): boolean {
    const controller = this.inFlightRuns.get(runId)
    if (controller === undefined) return false
    controller.abort(reason)
    this.inFlightRuns.delete(runId)
    return true
  }

  /** Process / session supervisors hosted by the gateway. */
  get managers(): GatewayManagers {
    if (this.managersInternal === null) {
      throw new Error('gateway managers are not available — start() the gateway first')
    }
    return this.managersInternal
  }

  /**
   * Register a token-to-policy mapping for an agent step.
   * The token is passed to the subprocess as SKELM_EGRESS_TOKEN.
   */
  registerEgressToken(runId: string, stepId: string, policy: NetworkPolicy): string {
    if (this.tokenPolicyStore === null) {
      throw new Error('egress proxy is not available — start() the gateway first')
    }
    const token = `${runId}:${stepId}`
    this.tokenPolicyStore.set(token, policy)
    return token
  }

  /**
   * Unregister a token when the step completes.
   */
  unregisterEgressToken(runId: string, stepId: string): void {
    if (this.tokenPolicyStore === null) return
    const token = `${runId}:${stepId}`
    this.tokenPolicyStore.delete(token)
  }

  /**
   * Get proxy environment variables to inject into agent subprocesses.
   * Returns undefined if the proxy is disabled or not running.
   */
  getProxyEnvVars(): Record<string, string> | undefined {
    if (this.egressProxy === null) return undefined
    const config = this.getConfig()
    const proxyConfig = config.server?.proxy
    if (proxyConfig?.enabled === false) return undefined
    const port = this.egressProxy.getPort()
    return {
      HTTP_PROXY: `http://127.0.0.1:${port}`,
      HTTPS_PROXY: `http://127.0.0.1:${port}`,
    }
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
        url: this.options.url ?? 'http://127.0.0.1:14738',
        token: this.options.token,
        startedAt: this.lockfile.startedAt,
      }
      await writeDiscovery(this.discoveryPath, this.discovery)
      this.runStoreInternal = this.buildRunStore()
      this.enforcementInternal = this.buildEnforcement()
      this.registriesInternal = await this.buildRegistries()
      this.managersInternal = await this.buildManagers()
      // Wire the trigger dispatcher now that managers + registries exist.
      // Without a loadWorkflow option the coordinator keeps its no-op
      // onFire — fired triggers still record their accounting but do not
      // start runs, which matches embedded/test gateways.
      if (this.options.loadWorkflow !== undefined) {
        const loadWorkflow = this.options.loadWorkflow
        this.managersInternal.triggers.setOnFire(
          createTriggerDispatcher({ gateway: this, loadWorkflow }),
        )
      }
      if (this.options.enableMetrics) {
        const { MetricsCollector } = await import('@skelm/metrics')
        this.metricsInternal = new MetricsCollector()
      }
      // Start the egress proxy before HTTP server
      await this.startEgressProxy()
      if (this.options.enableHttp) {
        await this.startHttp()
      }
      if (this.options.installSignalHandlers) this.attachSignals()
      this.state = 'running'
    } catch (err) {
      this.state = 'stopped'
      this.lockfile = null
      this.discovery = null
      this.registriesInternal = null
      this.enforcementInternal = null
      this.managersInternal = null
      this.runStoreInternal = null
      this.egressProxy = null
      this.tokenPolicyStore = null
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
      this.enforcementInternal = this.buildEnforcement()
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
      // Stop the egress proxy before HTTP server
      await this.stopEgressProxy()
      if (this.httpServer !== null) {
        await this.httpServer.stop()
        this.httpServer = null
      }
      if (this.managersInternal !== null) {
        await this.managersInternal.triggers.stop()
        await this.managersInternal.mcp.stopAll()
        await this.managersInternal.codingAgents.stopAll()
      }
      if (this.registriesInternal !== null) {
        await Promise.all([
          this.registriesInternal.workflows.close(),
          this.registriesInternal.skills.close(),
          this.registriesInternal.agents.close(),
          this.registriesInternal.mcpServers.close(),
        ])
      }
      // Drain pending approvals if the gate is the suspend implementation
      const gate = this.enforcementInternal?.approvalGate
      if (gate instanceof SuspendApprovalGate) gate.drain('gateway stopping')
      await removeDiscovery(this.discoveryPath)
      await releaseLockfile(this.lockfilePath)
    } finally {
      this.state = 'stopped'
      this.lockfile = null
      this.discovery = null
      this.registriesInternal = null
      this.enforcementInternal = null
      this.managersInternal = null
      this.runStoreInternal = null
      this.egressProxy = null
      this.tokenPolicyStore = null
    }
  }

  private async startHttp(): Promise<void> {
    if (this.runStoreInternal === null) throw new Error('runStore must be built before HTTP starts')
    const port = this.options.httpPort ?? this.config.server?.port ?? 14738
    const host = this.options.httpHost ?? this.config.server?.host ?? '127.0.0.1'
    const auth = this.config.server?.auth?.mode === 'bearer' ? 'bearer' : 'none'
    this.httpServer = createServer(
      {
        port,
        host,
        auth,
        ...(this.options.token !== undefined && { token: this.options.token }),
      },
      {
        pipelines: [],
        runStore: this.runStoreInternal,
        runner: undefined as never, // gateway-routed runs go through the dispatcher; the server's own /pipelines/:id/run is unused here
        gateway: this,
      },
    )
    await this.httpServer.start()
    if (this.discovery !== null) {
      this.discovery = { ...this.discovery, url: `http://${host}:${port}` }
      await writeDiscovery(this.discoveryPath, this.discovery)
    }
  }

  private async startEgressProxy(): Promise<void> {
    const proxyConfig = this.config.server?.proxy
    const enabled = proxyConfig?.enabled ?? true
    if (!enabled) return

    if (this.enforcementInternal === null) {
      throw new Error('enforcement must be built before egress proxy starts')
    }

    this.tokenPolicyStore = new InMemoryTokenPolicyStore()
    const serverPort = this.config.server?.port ?? 14738
    const proxyPort = proxyConfig?.port ?? serverPort + 1

    this.egressProxy = new EgressProxy({
      port: proxyPort,
      host: '127.0.0.1',
      tokenStore: this.tokenPolicyStore,
      auditWriter: this.enforcementInternal.auditWriter,
      defaultPolicy: 'deny',
    })

    await this.egressProxy.start()
  }

  private async stopEgressProxy(): Promise<void> {
    if (this.egressProxy !== null) {
      await this.egressProxy.stop()
      this.egressProxy = null
    }
    if (this.tokenPolicyStore !== null) {
      this.tokenPolicyStore = null
    }
  }

  private buildRunStore(): RunStore {
    if (this.options.runStore !== undefined) return this.options.runStore
    const cfg = this.config.storage?.runs
    if (cfg === undefined || cfg.driver === 'sqlite') {
      const dbPath = expandHome(cfg?.path ?? join(this.stateDir, 'runs.sqlite'))
      return new SqliteRunStore({ path: dbPath })
    }
    return new MemoryRunStore()
  }

  private async buildManagers(): Promise<GatewayManagers> {
    const mcp = new McpServerManager()
    const codingAgents = new CodingAgentManager({
      getProxyEnv: () => this.getProxyEnvVars(),
    })
    const acpSessions = new AcpSessionManager({
      storePath: defaultAcpSessionStorePath(this.stateDir),
    })
    // The coordinator starts with a no-op onFire. start() replaces it with
    // a createTriggerDispatcher() callback when GatewayOptions.loadWorkflow
    // is supplied — production wires this to tsx's tsImport(); tests can
    // pass a fake loader.
    const triggers = new TriggerCoordinator({ onFire: async () => {} })
    await mcp.startAll(this.config.registries?.mcpServers ?? [])
    await codingAgents.startAll(this.config.registries?.agents ?? [])
    await acpSessions.reconcile()
    return { mcp, codingAgents, acpSessions, triggers }
  }

  private buildEnforcement(): GatewayEnforcement {
    const defaults = this.config.defaults?.permissions
    const profiles = this.config.defaults?.permissionProfiles ?? {}

    // Default to the chain-backed audit writer at <stateDir>/audit.jsonl
    // when the caller did not inject one.
    const auditWriter =
      this.options.auditWriter ??
      (this.options.stateDir !== undefined || this.stateDir !== ''
        ? new ChainAuditWriter(join(this.stateDir, 'audit.jsonl'))
        : new NoopAuditWriter())

    // Default to the file-backed secret driver when the config asks for it
    // or the user supplied a path; otherwise read from process.env.
    const secretsCfg = this.config.secrets
    let secretResolver = this.options.secretResolver
    if (secretResolver === undefined) {
      if (secretsCfg?.driver === 'file') {
        const path = secretsCfg.file ?? join(this.stateDir, 'secrets.json')
        secretResolver = new FileSecretResolver(path)
      } else {
        secretResolver = new EnvSecretResolver()
      }
    }

    // Default to the suspend gate so production runs actually wait for
    // an approver. AutoApproveGate is an explicit opt-in for tests.
    const approvalGate =
      this.options.approvalGate ??
      new SuspendApprovalGate({ persistPath: join(this.stateDir, 'approvals.json') })

    return {
      permissionResolver: new PermissionResolver({
        ...(defaults !== undefined && { defaults }),
        profiles,
      }),
      auditWriter,
      secretResolver,
      approvalGate,
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

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}
