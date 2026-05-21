import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type ApprovalGate,
  type AuditWriter,
  DEFAULT_CONFIG,
  EnvSecretResolver,
  MemoryRunStore,
  type NetworkPolicy,
  NoopAuditWriter,
  PermissionResolver,
  type RunStore,
  Runner,
  type SecretResolver,
  type SkelmConfig,
  SqliteRunStore,
} from '@skelm/core'
import { SuspendApprovalGate } from '../approvals/suspend-gate.js'
import { ChainAuditWriter } from '../audit/chain.js'
import { BreakpointRegistry } from '../debug/breakpoint-registry.js'
import { type SkelmServer, createServer } from '../http/index.js'
import { loadPipelineFromPath, makeGatewayPipelineRegistry } from '../http/routes/utils.js'
import { AcpSessionManager, defaultAcpSessionStorePath } from '../managers/acp-session-manager.js'
import { CodingAgentManager } from '../managers/coding-agent-manager.js'
import { McpServerManager } from '../managers/mcp-server-manager.js'
import { EgressProxy, InMemoryTokenPolicyStore, type TokenPolicyMap } from '../proxy/index.js'
import {
  AgentRegistry,
  McpServerRegistry,
  SkillRegistry,
  WorkflowRegistry,
} from '../registries/index.js'
import { createSkillSource } from '../registries/skill-source.js'
import { FileSecretResolver } from '../secrets/file-driver.js'
import { TriggerCoordinator } from '../triggers/coordinator.js'
import { createTriggerDispatcher } from '../triggers/dispatcher.js'
import type { WorkflowArchiveService } from '../workflows/workflow-archive-service.js'
import type { WorkflowRegistrationService } from '../workflows/workflow-registration-service.js'
import { type DiscoveryRecord, removeDiscovery, writeDiscovery } from './discovery.js'
import type {
  GatewayEnforcement,
  GatewayManagers,
  GatewayOptions,
  GatewayRegistries,
  GatewayState,
} from './gateway-types.js'
import { type LockfileContents, acquireLockfile, releaseLockfile } from './lockfile.js'
import { recoverInterruptedRuns } from './recovery.js'

export type {
  GatewayEnforcement,
  GatewayManagers,
  GatewayOptions,
  GatewayRegistries,
  GatewayState,
} from './gateway-types.js'

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
  private workflowRegistrationInternal: WorkflowRegistrationService | null = null
  private workflowArchiveInternal: WorkflowArchiveService | null = null
  /** In-flight reload promise; null when no reload is running. */
  private reloadInFlight: Promise<void> | null = null
  /** Coalesced follow-up reload promise — at most one outstanding. */
  private reloadPendingAfter: Promise<void> | null = null

  constructor(private readonly options: GatewayOptions = {}) {
    this.stateDir = options.stateDir ?? join(homedir(), '.skelm')
    this.projectRoot = resolve(options.projectRoot ?? process.cwd())
    this.lockfilePath = join(this.stateDir, 'gateway.lock')
    this.discoveryPath = join(this.stateDir, 'gateway.json')
    // When the caller does not supply a config (typical for embedded /
    // test construction), bind both the HTTP server and the egress proxy
    // to OS-assigned ports so concurrent gateway instances do not collide
    // on the documented production defaults (14738 / 14739). The CLI
    // (`skelm gateway start`) always supplies a config, so production
    // behavior is unchanged.
    if (options.config !== undefined) {
      this.config = options.config
    } else {
      const defaultServer = DEFAULT_CONFIG.server ?? {}
      this.config = {
        ...DEFAULT_CONFIG,
        server: {
          ...defaultServer,
          port: 0,
          proxy: { ...(defaultServer.proxy ?? {}), port: 0 },
        },
      }
    }
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
    return requireStarted(this.registriesInternal, 'gateway registries are not available')
  }

  /** Trust-boundary instances the gateway hands to Runners it constructs. */
  get enforcement(): GatewayEnforcement {
    return requireStarted(this.enforcementInternal, 'gateway enforcement is not available')
  }

  /** The durable RunStore; constructed at start() per the storage config. */
  get runStore(): RunStore {
    return requireStarted(this.runStoreInternal, 'gateway runStore is not available')
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

  /** Extra directories that POST /v1/workflows/register accepts. Empty by default. */
  getAllowedRegistrationDirs(): string[] {
    return this.options.allowedRegistrationDirs ?? []
  }

  /** Maximum items accepted by a single POST /v1/batch/runs request. */
  getBatchMaxItemsPerRequest(): number {
    const value = this.options.batch?.maxItemsPerRequest
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return value
    return 50
  }

  /** Maximum byte size of an uploaded workflow .zip. */
  getWorkflowMaxArchiveBytes(): number {
    const value = this.options.workflows?.maxArchiveBytes
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return value
    return 5 * 1024 * 1024
  }

  /**
   * The workflow-registration service backs /v1/workflows/* routes. Lazily
   * constructed once registries are available and replayed from disk during
   * start(); throws if accessed before start() completes.
   */
  getWorkflowRegistrationService(): WorkflowRegistrationService {
    return requireStarted(
      this.workflowRegistrationInternal,
      'workflow registration service is not available',
    )
  }

  /** The archive-extraction service backing multipart .zip uploads. */
  getWorkflowArchiveService(): WorkflowArchiveService {
    return requireStarted(this.workflowArchiveInternal, 'workflow archive service is not available')
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

  /**
   * Shared async-start path used by `POST /pipelines/:id/start` and the batch
   * fan-out route. Constructs a Runner with the gateway's enforcement, wires
   * skills + sub-pipeline lookup, registers the run for cancellation, and
   * fires it without awaiting. Returns the registered runId; callers handle
   * idempotency and response shaping.
   *
   * Thrown errors carry a `.statusCode` so h3 surfaces them with the right
   * HTTP status (404 for unknown id, 501 when no loader is wired). Errors
   * raised by `loadPipelineFromPath` (load failure, missing default export)
   * propagate through unchanged.
   */
  async startPipelineAsync(pipelineId: string, input: unknown): Promise<{ runId: string }> {
    const entry = this.registries.workflows.get(pipelineId)
    if (entry === undefined) {
      throw startPipelineError(404, 'pipeline not found')
    }
    const loader = this.getWorkflowLoader()
    if (loader === undefined) {
      throw startPipelineError(501, 'gateway has no workflow loader')
    }
    const pipeline = await loadPipelineFromPath(loader, pipelineId, entry.path)
    const enforcement = this.enforcement
    const runner = new Runner({
      approvalGate: enforcement.approvalGate,
      secretResolver: enforcement.secretResolver,
      auditWriter: enforcement.auditWriter,
      store: this.runStore,
    })
    this.attachMetricsBus(runner.events)
    const controller = new AbortController()
    const runId = crypto.randomUUID()
    this.registerRun(runId, controller, runner)
    // If runner.start() throws synchronously the run never gets a handle, so
    // the `.finally(unregisterRun)` below would leak the registration. Unwind
    // here so an in-flight cancellation can't see a phantom runId.
    let handle: ReturnType<Runner['start']>
    try {
      handle = runner.start(pipeline as Parameters<Runner['start']>[0], (input ?? {}) as never, {
        runId,
        signal: controller.signal,
        skillSource: createSkillSource({
          registry: this.registries.skills,
          workflowPath: entry.path,
        }),
        pipelineRegistry: makeGatewayPipelineRegistry(this),
      })
    } catch (err) {
      this.unregisterRun(runId)
      throw err
    }
    void handle
      .wait()
      .catch((err) => {
        // Runner already persists the failure to the run store; this log
        // surfaces it in the gateway process output so an operator tailing
        // stderr sees the rejection instead of silent loss.
        console.error(`gateway: run ${runId} wait rejected:`, (err as Error)?.message ?? err)
      })
      .finally(() => this.unregisterRun(runId))
    return { runId }
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
    return requireStarted(this.managersInternal, 'gateway managers are not available')
  }

  /**
   * Register a token-to-policy mapping for an agent step.
   * The token is passed to the subprocess as SKELM_EGRESS_TOKEN.
   */
  registerEgressToken(runId: string, stepId: string, policy: NetworkPolicy): string {
    const store = requireStarted(this.tokenPolicyStore, 'egress proxy is not available')
    const token = `${runId}:${stepId}`
    store.set(token, policy)
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
   *
   * When `egressToken` is provided, it is encoded as the credential field of
   * the proxy URL (`http://token:<egressToken>@host:port`). Standard HTTP
   * clients (Node `http`/`https`, undici, curl, requests, …) extract the
   * credential from the proxy URL and send `Proxy-Authorization: Basic
   * <base64(token:<egressToken>)>` automatically. Without that encoding the
   * proxy never receives the token and falls back to its default-deny policy.
   *
   * `SKELM_EGRESS_TOKEN` is still emitted for callers that want to read the
   * raw token (e.g. for explicit Bearer auth in custom clients), but it is
   * advisory; the URL credential is what makes the standard clients work.
   */
  getProxyEnvVars(egressToken?: string): Record<string, string> | undefined {
    if (this.egressProxy === null) return undefined
    const config = this.getConfig()
    const proxyConfig = config.server?.proxy
    if (proxyConfig?.enabled === false) return undefined
    const port = this.egressProxy.getPort()
    const userInfo =
      egressToken !== undefined && egressToken !== ''
        ? `${encodeURIComponent('token')}:${encodeURIComponent(egressToken)}@`
        : ''
    const url = `http://${userInfo}127.0.0.1:${port}`
    const env: Record<string, string> = {
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
    }
    if (egressToken !== undefined && egressToken !== '') {
      env.SKELM_EGRESS_TOKEN = egressToken
    }
    return env
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
        url: this.options.url ?? defaultDiscoveryUrl(this.options, this.config),
        token: this.options.token,
        startedAt: this.lockfile.startedAt,
      }
      await writeDiscovery(this.discoveryPath, this.discovery)
      this.runStoreInternal = this.buildRunStore()
      // Finalize any Run records left in `running` state from a previous
      // process — those runs were interrupted by crash/SIGKILL/restart and
      // must be marked failed before new runs start so listRuns reflects
      // ground truth and operators can see what was lost.
      await recoverInterruptedRuns(this.runStoreInternal)
      this.enforcementInternal = this.buildEnforcement()
      this.registriesInternal = await this.buildRegistries()
      this.managersInternal = await this.buildManagers()
      this.workflowArchiveInternal = await this.buildWorkflowArchiveService()
      this.workflowRegistrationInternal = await this.buildWorkflowRegistrationService()
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
      // F042: lockfile + discovery are acquired before the HTTP listener
      // binds, so a listen-time failure (most commonly EADDRINUSE) would
      // leave stale state on disk if we only nulled the in-memory refs.
      // Release every external artefact before resetting state.
      try {
        await this.stopEgressProxy()
      } catch {
        // swallow — we're already in an error path
      }
      if (this.httpServer !== null) {
        try {
          await this.httpServer.stop()
        } catch {
          // swallow
        }
        this.httpServer = null
      }
      try {
        await removeDiscovery(this.discoveryPath)
      } catch {
        // swallow — the file may not have been written yet
      }
      try {
        await releaseLockfile(this.lockfilePath)
      } catch {
        // swallow — best-effort cleanup
      }
      this.state = 'stopped'
      this.lockfile = null
      this.discovery = null
      this.registriesInternal = null
      this.enforcementInternal = null
      this.managersInternal = null
      this.runStoreInternal = null
      this.egressProxy = null
      this.tokenPolicyStore = null
      this.workflowRegistrationInternal = null
      this.workflowArchiveInternal = null
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
   *
   * Serialized: only one reload runs at a time. Concurrent callers (the
   * SIGHUP handler, the FsWatcher's per-file change events, and an
   * explicit `POST /gateway/reload`) all share the same in-flight
   * promise. Without this, a burst of file edits could queue dozens of
   * concurrent `tsImport` + `onReload` cycles and lock the event loop
   * (the onReload hook does work proportional to the workflow count, so
   * the pile-up is worse than the registry-refresh-only cost before
   * `onReload` was introduced).
   */
  async reload(nextConfig?: SkelmConfig): Promise<void> {
    if (this.reloadInFlight !== null) {
      // If a reload is already running, await it and also schedule one
      // more pass — there could be changes that arrived after the
      // in-flight reload started its registry refresh. The second pass
      // is itself coalesced by this same check, so two concurrent
      // callers + the in-flight pass settle into at most one follow-up.
      await this.reloadInFlight
      if (this.reloadPendingAfter !== null) return this.reloadPendingAfter
      this.reloadPendingAfter = this.runReload(nextConfig).finally(() => {
        this.reloadPendingAfter = null
      })
      return this.reloadPendingAfter
    }
    this.reloadInFlight = this.runReload(nextConfig).finally(() => {
      this.reloadInFlight = null
    })
    return this.reloadInFlight
  }

  private async runReload(nextConfig?: SkelmConfig): Promise<void> {
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
    if (this.options.onReload !== undefined) {
      try {
        await this.options.onReload()
      } catch (err) {
        console.error('gateway onReload hook failed:', (err as Error).message)
      }
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
      this.workflowRegistrationInternal = null
      this.workflowArchiveInternal = null
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
    // If neither the proxy port nor the HTTP server port is explicitly set,
    // bind to an OS-assigned port (0). Concurrent gateway instances (typically
    // tests) need port isolation; production users always set server.port via
    // defineConfig() so production behavior is unchanged.
    const serverPort = this.config.server?.port
    const explicitProxyPort = proxyConfig?.port
    const proxyPort =
      explicitProxyPort !== undefined
        ? explicitProxyPort
        : serverPort !== undefined
          ? serverPort + 1
          : 0

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
      getProxyEnv: (egressToken) => this.getProxyEnvVars(egressToken),
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
      new SuspendApprovalGate({
        persistPath: join(this.stateDir, 'approvals.json'),
        auditWriter,
      })

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

  private async buildWorkflowRegistrationService(): Promise<WorkflowRegistrationService> {
    if (this.registriesInternal === null) {
      throw new Error('registries must be built before workflow registration service')
    }
    const { WorkflowRegistrationService: Ctor } = await import(
      '../workflows/workflow-registration-service.js'
    )
    const service = new Ctor({
      stateDir: this.stateDir,
      registry: this.registriesInternal.workflows,
      projectRoot: this.projectRoot,
      allowedDirs: this.options.allowedRegistrationDirs ?? [],
      ...(this.workflowArchiveInternal !== null && {
        archiveRoot: this.workflowArchiveInternal.uploadRoot,
      }),
    })
    await service.loadFromDisk()
    return service
  }

  private async buildWorkflowArchiveService(): Promise<WorkflowArchiveService> {
    const { WorkflowArchiveService: Ctor } = await import(
      '../workflows/workflow-archive-service.js'
    )
    return new Ctor({
      uploadRoot: join(this.stateDir, 'uploaded-workflows'),
      maxBytes: this.getWorkflowMaxArchiveBytes(),
    })
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

/** Narrow a lazily-initialized field to its non-null type, with a uniform suffix. */
function requireStarted<T>(value: T | null, notAvailableMsg: string): T {
  if (value === null) {
    throw new Error(`${notAvailableMsg} — start() the gateway first`)
  }
  return value
}

function startPipelineError(statusCode: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number }
  err.statusCode = statusCode
  return err
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/**
 * Build the discovery URL from the gateway's option / config inputs.
 *
 * Priority:
 *   1. `options.httpHost` / `options.httpPort` (CLI-supplied overrides)
 *   2. `config.server.host` / `config.server.port` (project config)
 *   3. The documented defaults (127.0.0.1:14738)
 *
 * `startHttp()` later rewrites the discovery URL with the same `host:port`
 * after the listener binds, but writing the correct URL here keeps the
 * discovery file useful for embedded gateways (constructed without
 * `enableHttp: true`) and during the brief window before HTTP is up.
 */
function defaultDiscoveryUrl(options: GatewayOptions, config: SkelmConfig): string {
  const host = options.httpHost ?? config.server?.host ?? '127.0.0.1'
  const port = options.httpPort ?? config.server?.port ?? 14738
  return `http://${host}:${port}`
}
