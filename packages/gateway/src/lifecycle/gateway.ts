import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentmemoryClient } from '@skelm/agentmemory'
import {
  type AgentPermissions,
  type ApprovalGate,
  type AuditWriter,
  BackendRegistry,
  DEFAULT_CONFIG,
  EnvSecretResolver,
  EventBus,
  type ExecutableProfileDefinition,
  MemoryRunStore,
  type NetworkPolicy,
  NoopAuditWriter,
  PermissionResolver,
  PostgresRunStore,
  type RunStore,
  type Runner,
  type SecretResolver,
  type SkelmConfig,
  SqliteRunStore,
  WorkspaceManager,
} from '@skelm/core'
import { SuspendApprovalGate } from '../approvals/suspend-gate.js'
import { ChainAuditWriter } from '../audit/chain.js'
import { ForwardingAuditWriter, buildAuditSinks } from '../audit/forwarder.js'
import { BreakpointRegistry } from '../debug/breakpoint-registry.js'
import { GatewayRuntime } from '../execution/gateway-runtime.js'
import { AcpSessionManager, defaultAcpSessionStorePath } from '../managers/acp-session-manager.js'
import { CodingAgentManager } from '../managers/coding-agent-manager.js'
import { McpServerManager } from '../managers/mcp-server-manager.js'
import { GatewayObservability } from '../observability/index.js'
import { EgressProxy, InMemoryTokenPolicyStore, type TokenPolicyMap } from '../proxy/index.js'
import {
  AgentRegistry,
  McpServerRegistry,
  SkillRegistry,
  WorkflowRegistry,
} from '../registries/index.js'
import { FileSecretResolver } from '../secrets/file-driver.js'
import { TaskService } from '../tasks/task-service.js'
import { TriggerCoordinator } from '../triggers/coordinator.js'
import { createTriggerDispatcher } from '../triggers/dispatcher.js'
import { DynamicScheduleStore } from '../triggers/dynamic-schedule-store.js'
import type { TriggerRegistration } from '../triggers/types.js'
import type { WorkflowArchiveService } from '../workflows/workflow-archive-service.js'
import type { WorkflowArtifactService } from '../workflows/workflow-artifact-service.js'
import type { WorkflowRegistrationService } from '../workflows/workflow-registration-service.js'
import { type DiscoveryRecord, removeDiscovery, writeDiscovery } from './discovery.js'
import type {
  GatewayContext,
  GatewayEnforcement,
  GatewayManagers,
  GatewayOptions,
  GatewayRegistries,
  GatewayState,
} from './gateway-types.js'
import { type LockfileContents, acquireLockfile, releaseLockfile } from './lockfile.js'
import { recoverInterruptedRuns } from './recovery.js'

export type {
  GatewayContext,
  GatewayEnforcement,
  GatewayManagers,
  GatewayOptions,
  GatewayRegistries,
  GatewayState,
} from './gateway-types.js'

/**
 * Long-running gateway lifecycle. Owns the lockfile, discovery file, signal
 * handlers, config-driven registries, enforcement, audit writer, HTTP listener,
 * supervisors, run store, and scheduler coordination.
 */
export class Gateway implements GatewayContext {
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
  private auditForwarderInternal: ForwardingAuditWriter | null = null
  private managersInternal: GatewayManagers | null = null
  private runStoreInternal: RunStore | null = null
  private workspaceManagerInternal: WorkspaceManager | null = null
  private httpServer: import('../http/types.js').SkelmServer | null = null
  private egressProxy: EgressProxy | null = null
  private tokenPolicyStore: TokenPolicyMap | null = null
  private agentmemoryClient: AgentmemoryClient | null = null
  private readonly runtimeInternal: GatewayRuntime
  private readonly observability = new GatewayObservability()
  /** Single shared EventBus that every per-request Runner publishes into,
   *  and that GET /runs/:id/stream subscribes to. Lazily-constructed; the
   *  first reader or writer creates it. */
  private eventsBusInternal: import('@skelm/core').EventBus | null = null
  private readonly breakpointsInternal: import('../debug/breakpoint-registry.js').BreakpointRegistry
  private tasksInternal: TaskService | null = null
  private workflowRegistrationInternal: WorkflowRegistrationService | null = null
  private workflowArchiveInternal: WorkflowArchiveService | null = null
  private workflowArtifactInternal: WorkflowArtifactService | null = null
  private dynamicScheduleStoreInternal: DynamicScheduleStore | null = null
  /** Backend registry, seeded from GatewayOptions; mutable so a runtime-
   *  activated project can absorb additional backends (see absorbBackends). */
  private backendsInternal: import('@skelm/core').BackendRegistry | undefined
  /** In-flight reload promise; null when no reload is running. */
  private reloadInFlight: Promise<void> | null = null
  /** Coalesced follow-up reload promise — at most one outstanding. */
  private reloadPendingAfter: Promise<void> | null = null

  constructor(private readonly options: GatewayOptions = {}) {
    // A config-less gateway (embedded / probe / test construction) that is
    // also given no explicit stateDir must NOT adopt the shared default
    // ~/.skelm: start()/stop() and the start() error path call
    // removeDiscovery(this.discoveryPath), so an embedded instance pointed at
    // ~/.skelm/gateway.json would delete a separately-running persistent
    // gateway's discovery record while that gateway is still alive — every
    // later CLI command then fails to discover it ("gateway did not become
    // ready"). Isolate the whole state dir per instance, mirroring how the
    // config-less branch below isolates the ports. The CLI's `gateway start`
    // always supplies a config and an explicit stateDir, so the conventional
    // shared gateway is unchanged.
    this.stateDir =
      options.stateDir ??
      (options.config === undefined
        ? mkdtempSync(join(tmpdir(), 'skelm-embedded-gateway-'))
        : join(homedir(), '.skelm'))
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
        // Do NOT inherit DEFAULT_CONFIG's deny-all permission baseline as an
        // operator default: the CLI loader deliberately treats framework
        // permission defaults as non-authoritative, and applying the empty
        // allow-lists as an intersection ceiling would deny every step. Keep
        // only non-permission defaults (e.g. backend) for the no-config path.
        ...(DEFAULT_CONFIG.defaults !== undefined && {
          defaults: stripPermissionDefaults(DEFAULT_CONFIG.defaults),
        }),
        server: {
          ...defaultServer,
          port: 0,
          proxy: { ...(defaultServer.proxy ?? {}), port: 0 },
        },
      }
    }
    this.breakpointsInternal = new BreakpointRegistry()
    this.backendsInternal = options.backends
    this.runtimeInternal = new GatewayRuntime(this)
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

  getAgentmemoryClient(): AgentmemoryClient | null {
    return this.agentmemoryClient
  }

  /**
   * Whether a workflow / persistent-workflow id is granted the unrestricted
   * permission bypass. The grant is operator-side only — the union of
   * `config.defaults.unrestrictedGrants` and the comma-separated env var
   * `SKELM_UNRESTRICTED_WORKFLOWS`. An author's `requestUnrestricted` is inert
   * unless this returns true. See `docs/concepts/permissions.md`.
   */
  isUnrestrictedGranted(workflowId: string): boolean {
    const fromConfig = this.config.defaults?.unrestrictedGrants ?? []
    if (fromConfig.includes(workflowId)) return true
    const fromEnv = (process.env.SKELM_UNRESTRICTED_WORKFLOWS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    return fromEnv.includes(workflowId)
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
   * The single WorkspaceManager every per-request Runner the gateway builds
   * must share, scoped to `<stateDir>/workspaces`. The `/workspaces` routes
   * (list/show/clean) read from this same base, so a persistent workspace a
   * run creates is visible to those routes. Without threading this into the
   * Runner, the runner falls back to its own default base (`~/.skelm/workspaces`)
   * and the two diverge under any non-default gateway state dir — the workspace
   * exists on disk but `skelm workspace list/show/clean` can't see it. Lazily
   * constructed and cached so all callers share one instance (one lock domain).
   */
  get workspaceManager(): WorkspaceManager {
    if (this.workspaceManagerInternal === null) {
      this.workspaceManagerInternal = new WorkspaceManager({
        persistentBase: join(this.stateDir, 'workspaces'),
      })
    }
    return this.workspaceManagerInternal
  }

  /** Shared backend registry as passed via GatewayOptions; undefined when
   *  the gateway was constructed without one. Per-request Runners thread
   *  this through so runs see the same backends config-defined or
   *  pre-built instances would. */
  get backends(): import('@skelm/core').BackendRegistry | undefined {
    return this.backendsInternal
  }

  get hitlPolicy(): import('@skelm/core').HitlPolicy | undefined {
    return this.options.hitlPolicy
  }

  get hitlEnvironment(): string | undefined {
    return this.options.hitlEnvironment
  }

  /**
   * Absorb the backends from a runtime-activated project's registry into this
   * gateway's registry, idempotently. A backend whose id is already registered
   * is left untouched — an activated config can add backends but never hijack
   * an already-trusted id. A gateway that booted without any registry gains one
   * lazily. Returns the ids that were newly registered vs. already present.
   */
  absorbBackends(registry: import('@skelm/core').BackendRegistry): {
    absorbed: string[]
    skipped: string[]
  } {
    if (this.backendsInternal === undefined) {
      this.backendsInternal = new BackendRegistry()
    }
    const absorbed: string[] = []
    const skipped: string[] = []
    for (const backend of registry.list()) {
      if (this.backendsInternal.registerIfAbsent(backend) === 'registered') {
        absorbed.push(backend.id)
      } else {
        skipped.push(backend.id)
      }
    }
    return { absorbed, skipped }
  }

  /**
   * Gateway-wide event bus. Every per-request Runner constructed by the
   * gateway publishes into this bus, and GET /runs/:id/stream subscribes
   * to it via `forRun(runId, ...)`. Without a single shared bus, events
   * emitted by Runners constructed in the HTTP routes never reach SSE
   * subscribers (the SSE handler can only subscribe to one bus).
   */
  get events(): EventBus {
    if (this.eventsBusInternal === null) {
      this.eventsBusInternal = new EventBus()
    }
    return this.eventsBusInternal
  }

  registerRun(runId: string, controller: AbortController, runner?: Runner): void {
    this.runtimeInternal.registerRun(runId, controller, runner)
  }

  unregisterRun(runId: string): void {
    this.runtimeInternal.unregisterRun(runId)
  }

  getRunner(runId: string): Runner | undefined {
    return this.runtimeInternal.getRunner(runId)
  }

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

  /** The managed-copy service for path-origin workflow artifacts. */
  getWorkflowArtifactService(): WorkflowArtifactService {
    return requireStarted(
      this.workflowArtifactInternal,
      'workflow artifact service is not available',
    )
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
    return this.observability.collector
  }

  /**
   * Detached-task lifecycle service. Lazily constructed so it binds to the
   * fully-initialized gateway context. `start()` is called during the lifecycle
   * `start()` once the run store and event bus exist.
   */
  get tasks(): TaskService {
    if (this.tasksInternal === null) {
      this.tasksInternal = new TaskService(this)
    }
    return this.tasksInternal
  }

  /** Subscribe an EventBus into the metrics collector. No-op when disabled. */
  attachMetricsBus(bus: import('@skelm/core').EventBus): void {
    this.observability.attachMetricsBus(bus)
  }

  /**
   * Subscribe an EventBus into the OpenTelemetry collector when
   * enableOtel:true. No-op when disabled. Disposers are tracked so stop()
   * can unsubscribe.
   */
  attachOtelBus(bus: import('@skelm/core').EventBus): void {
    this.observability.attachOtelBus(bus)
  }

  async startPipelineAsync(
    pipelineId: string,
    input: unknown,
    lineage?: import('../execution/gateway-runtime.js').RunLineage,
  ): Promise<{ runId: string }> {
    return this.runtimeInternal.startPipelineAsync(pipelineId, input, lineage)
  }

  async startAdhocRunByFile(
    absolutePath: string,
    registryId: string,
    input: unknown,
  ): Promise<{ runId: string; pipelineId: string }> {
    return this.runtimeInternal.startAdhocRunByFile(absolutePath, registryId, input)
  }

  async resumeWaitingRun(runId: string, resumeValue: unknown): Promise<void> {
    return this.runtimeInternal.resumeWaitingRun(runId, resumeValue)
  }

  cancel(runId: string, reason?: string): boolean {
    return this.runtimeInternal.cancel(runId, reason)
  }

  /** Process / session supervisors hosted by the gateway. */
  get managers(): GatewayManagers {
    return requireStarted(this.managersInternal, 'gateway managers are not available')
  }

  async persistDynamicSchedule(registration: TriggerRegistration): Promise<void> {
    await (this.dynamicScheduleStoreInternal ?? new DynamicScheduleStore(this.stateDir)).upsert(
      registration,
    )
  }

  async deleteDynamicSchedule(id: string): Promise<void> {
    await (this.dynamicScheduleStoreInternal ?? new DynamicScheduleStore(this.stateDir)).delete(id)
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

  egressRunOptions(): {
    registerEgressToken: (runId: string, stepId: string, policy: NetworkPolicy) => string
    unregisterEgressToken: (runId: string, stepId: string) => void
    getProxyEnv: (egressToken?: string) => Record<string, string> | undefined
  } {
    return this.runtimeInternal.egressRunOptions()
  }

  agentmemoryRunOptions(): {
    agentmemoryHandleFactory?: import('@skelm/core').AgentmemoryHandleFactory
  } {
    return this.runtimeInternal.agentmemoryRunOptions()
  }

  hitlRunOptions(): {
    hitlPolicy?: import('@skelm/core').HitlPolicy
    hitlEnvironment?: string
  } {
    return this.runtimeInternal.hitlRunOptions()
  }

  defaultPermissionRunOptions(workflowId?: string): {
    defaultPermissions?: AgentPermissions
    permissionProfiles?: Readonly<Record<string, AgentPermissions>>
    executableProfiles?: Readonly<Record<string, ExecutableProfileDefinition>>
  } {
    return this.runtimeInternal.defaultPermissionRunOptions(workflowId)
  }

  registerWorkflowProjectPermissions(
    workflowId: string,
    permissions: {
      defaultPermissions?: AgentPermissions
      permissionProfiles?: Readonly<Record<string, AgentPermissions>>
      executableProfiles?: Readonly<Record<string, ExecutableProfileDefinition>>
    },
  ): void {
    this.runtimeInternal.registerWorkflowProjectPermissions(workflowId, permissions)
  }

  unregisterWorkflowProjectPermissions(workflowId: string): void {
    this.runtimeInternal.unregisterWorkflowProjectPermissions(workflowId)
  }

  defaultBackendRunOptions(workflowId?: string): {
    defaultAgentBackend?: string
    defaultInferBackend?: string
  } {
    return this.runtimeInternal.defaultBackendRunOptions(workflowId)
  }

  registerWorkflowProjectBackends(
    workflowId: string,
    backends: { defaultAgentBackend?: string; defaultInferBackend?: string },
  ): void {
    this.runtimeInternal.registerWorkflowProjectBackends(workflowId, backends)
  }

  unregisterWorkflowProjectBackends(workflowId: string): void {
    this.runtimeInternal.unregisterWorkflowProjectBackends(workflowId)
  }

  private async initAgentmemory(): Promise<void> {
    const cfg = this.config.agentmemory
    if (!cfg || cfg.enabled !== true) return
    const url = cfg.url ?? 'http://localhost:3111'
    const timeoutMs = cfg.timeoutMs ?? 3000
    let secret: string | undefined
    if (cfg.secretName !== undefined && this.enforcementInternal !== null) {
      try {
        secret = await this.enforcementInternal.secretResolver.resolve(cfg.secretName)
      } catch {
        secret = undefined
      }
    }
    this.agentmemoryClient = new AgentmemoryClient({
      url,
      timeoutMs,
      ...(secret !== undefined ? { secret } : {}),
    })
    // Non-blocking health probe: never delay start() by the server's latency,
    // and never throw into the start path. A failed probe is non-fatal — agent
    // steps still run, only the memory effect is lost. The `.catch` makes this
    // a handled rejection, so it can't surface as an unhandled rejection in the
    // gateway's main loop.
    void this.agentmemoryClient
      .health()
      .then(() => {
        console.error(`gateway: agentmemory client wired (${url})`)
      })
      .catch((err: unknown) => {
        console.warn(
          `gateway: agentmemory configured (${url}) but health check failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })
  }

  /**
   * Wire the agentmemory client from the current config if it is not already
   * wired. Idempotent: a no-op when the client is present. `reload()` swaps the
   * config but does not (re)initialize agentmemory, so project activation that
   * adopts an agentmemory block calls this after reload to bring the client up.
   */
  async reinitAgentmemory(): Promise<void> {
    if (this.agentmemoryClient !== null) return
    await this.initAgentmemory()
  }

  /** True when the gateway has the agentmemory client wired. */
  get agentmemoryEnabled(): boolean {
    return this.agentmemoryClient !== null
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
        token: this.effectiveHttpToken(),
        startedAt: this.lockfile.startedAt,
      }
      await writeDiscovery(this.discoveryPath, this.discovery)
      this.runStoreInternal = this.buildRunStore()
      // Finalize any Run records left in `running` state from a previous
      // process — those runs were interrupted by crash/SIGKILL/restart and
      // must be marked failed before new runs start so listRuns reflects
      // ground truth and operators can see what was lost.
      await recoverInterruptedRuns(this.runStoreInternal)
      // Reconcile detached tasks whose child run was finalized (including by
      // the recovery pass above) while the gateway was down, then subscribe
      // for live child-run completion. Runs after run recovery so a crashed
      // 'running' task whose child is now 'failed' transitions correctly.
      await this.tasks.reconcile()
      this.tasks.start()
      // Reap orphan ephemeral workspaces left by interrupted runs (plan §4.4).
      // Conservative: only deletes directories that carry a skelm
      // `.skelm/workspace.json` metadata file with mode:'ephemeral' AND
      // whose lastAccessAt is past the grace window. Failure is non-fatal —
      // disk leaks are recoverable, but blocking start on tmpdir scans
      // would be a worse failure mode.
      void this.workspaceManager
        .reapStaleEphemeralWorkspaces({})
        .then(({ reaped }) => {
          if (reaped.length > 0) {
            console.error(`gateway: reaped ${reaped.length} orphan ephemeral workspace(s)`)
          }
        })
        .catch((err: unknown) => {
          console.warn(
            `gateway: ephemeral workspace reap failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        })
      this.enforcementInternal = this.buildEnforcement()
      {
        const gate = this.enforcementInternal.approvalGate
        if (gate instanceof SuspendApprovalGate) await gate.load()
      }
      await this.wireAuditForwarding()
      this.registriesInternal = await this.buildRegistries()
      this.managersInternal = await this.buildManagers()
      this.dynamicScheduleStoreInternal = new DynamicScheduleStore(this.stateDir)
      this.workflowArchiveInternal = await this.buildWorkflowArchiveService()
      this.workflowArtifactInternal = await this.buildWorkflowArtifactService()
      this.workflowRegistrationInternal = await this.buildWorkflowRegistrationService()
      // Wire the trigger dispatcher now that managers + registries exist.
      // Without a loadWorkflow option the coordinator keeps its no-op
      // onFire — fired triggers still record their accounting but do not
      // start runs, which matches embedded/test gateways.
      if (this.options.loadWorkflow !== undefined) {
        const loadWorkflow = this.options.loadWorkflow
        this.managersInternal.triggers.setOnFire(
          createTriggerDispatcher({
            gateway: this,
            loadWorkflow,
            ...(this.backendsInternal !== undefined && { backends: this.backendsInternal }),
          }),
        )
      }
      await this.replayDynamicSchedules()
      await this.observability.init({
        ...(this.options.enableMetrics !== undefined && {
          enableMetrics: this.options.enableMetrics,
        }),
        ...(this.options.enableOtel !== undefined && { enableOtel: this.options.enableOtel }),
      })
      await this.initAgentmemory()
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
      this.auditForwarderInternal = null
      this.managersInternal = null
      this.runStoreInternal = null
      this.egressProxy = null
      this.tokenPolicyStore = null
      this.workflowRegistrationInternal = null
      this.workflowArchiveInternal = null
      this.dynamicScheduleStoreInternal = null
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
   * concurrent `import()` + `onReload` cycles and lock the event loop
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
      const gate = this.enforcementInternal.approvalGate
      if (gate instanceof SuspendApprovalGate) await gate.load()
      await this.wireAuditForwarding()
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

  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.state === 'stopped') return
    this.state = 'stopping'
    // Bounded drain: a wedged HTTP server / MCP manager / coding agent
    // child must not hold up SIGTERM indefinitely. Race the full drain
    // against a timeout; on timeout the finally block still clears
    // in-memory state and the operator's supervisor (systemd) sees the
    // exit instead of being forced to SIGKILL.
    const timeoutMs = options.timeoutMs ?? 30_000
    const drain = (async () => {
      this.detachSignals()
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
      const gate = this.enforcementInternal?.approvalGate
      if (gate instanceof SuspendApprovalGate) await gate.drain('gateway stopping')
      await removeDiscovery(this.discoveryPath)
      await releaseLockfile(this.lockfilePath)
    })()
    try {
      await Promise.race([
        drain,
        new Promise<void>((_, reject) => {
          const t = setTimeout(
            () => reject(new Error(`gateway stop exceeded ${timeoutMs}ms drain budget`)),
            timeoutMs,
          )
          t.unref?.()
        }),
      ])
    } finally {
      this.tasksInternal?.stop()
      this.tasksInternal = null
      this.observability.dispose()
      if (this.auditForwarderInternal !== null) {
        await this.auditForwarderInternal.close().catch(() => {})
      }
      this.state = 'stopped'
      this.lockfile = null
      this.discovery = null
      this.registriesInternal = null
      this.enforcementInternal = null
      this.auditForwarderInternal = null
      this.managersInternal = null
      this.runStoreInternal = null
      this.egressProxy = null
      this.tokenPolicyStore = null
      this.workflowRegistrationInternal = null
      this.workflowArchiveInternal = null
      this.dynamicScheduleStoreInternal = null
    }
  }

  private async startHttp(): Promise<void> {
    if (this.runStoreInternal === null) throw new Error('runStore must be built before HTTP starts')
    const port = this.options.httpPort ?? this.config.server?.port ?? 14738
    const host = this.options.httpHost ?? this.config.server?.host ?? '127.0.0.1'
    const auth = this.config.server?.auth?.mode === 'bearer' ? 'bearer' : 'none'
    const token = this.effectiveHttpToken()
    const { createServer } = await import('../http/index.js')
    this.httpServer = createServer(
      {
        port,
        host,
        auth,
        ...(token !== undefined && { token }),
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

  private effectiveHttpToken(): string | undefined {
    if (this.config.server?.auth?.mode !== 'bearer') return undefined
    const token = this.options.token ?? this.config.server.token ?? process.env.SKELM_TOKEN
    const trimmed = token?.trim()
    return trimmed === undefined || trimmed === '' ? undefined : trimmed
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
    //
    // The CLI `--http-port` override (this.options.httpPort) participates in
    // the same precedence as startHttp() — without it, two gateways launched
    // with distinct `--http-port` flags would still both derive proxyPort from
    // the default config (14738) and collide on 14739.
    const serverPort = this.options.httpPort ?? this.config.server?.port
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
    if (cfg.driver === 'postgres') {
      if (cfg.url === undefined) {
        throw new Error('storage.runs.url is required when runs.driver is postgres')
      }
      return new PostgresRunStore({
        url: cfg.url,
        ...(cfg.schema !== undefined && { schema: cfg.schema }),
        ...(cfg.poolSize !== undefined && { poolSize: cfg.poolSize }),
        ...(cfg.artifactQuotaBytes !== undefined && { artifactQuotaBytes: cfg.artifactQuotaBytes }),
      })
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
    // is supplied — production wires this to native dynamic import(); tests can
    // pass a fake loader.
    //
    // onFireError / onQueueDrop default to no-ops on the coordinator, so a
    // triggered workflow failing on every fire, or a full queue silently
    // dropping fires, would only surface on an in-memory reg field stderr never
    // sees. Wire both to the operator log here so a continuously-failing trigger
    // isn't invisible.
    const triggers = new TriggerCoordinator({
      onFire: async () => {},
      onFireError: (triggerId, err) => {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
        process.stderr.write(`[skelm trigger] dispatch failed for "${triggerId}": ${detail}\n`)
      },
      onQueueDrop: (triggerId, queueDepth) => {
        process.stderr.write(
          `[skelm trigger] queue full for "${triggerId}" (depth ${queueDepth}); fire dropped\n`,
        )
      },
      onNextFireAtUpdated: (registration) => {
        void this.dynamicScheduleStoreInternal?.upsert(registration)
      },
      onOneShotCompleted: (registration) => {
        void this.dynamicScheduleStoreInternal?.delete(registration.spec.id)
      },
    })
    await mcp.startAll(this.config.registries?.mcpServers ?? [])
    await codingAgents.startAll(this.config.registries?.agents ?? [])
    await acpSessions.reconcile()
    return { mcp, codingAgents, acpSessions, triggers }
  }

  private async replayDynamicSchedules(): Promise<void> {
    if (this.managersInternal === null) return
    const store = this.dynamicScheduleStoreInternal ?? new DynamicScheduleStore(this.stateDir)
    const records = await store.list()
    for (const record of records) {
      // Skip one-shot triggers during replay: immediate fires instantly and
      // past-due at triggers also fire on registration. These are not
      // durable schedules and should not re-fire on every restart.
      if (record.spec.kind === 'immediate') {
        await store.delete(record.spec.id)
        continue
      }
      if (record.spec.kind === 'at') {
        const ts = Date.parse(record.spec.when)
        if (!Number.isNaN(ts) && ts <= Date.now()) {
          await store.delete(record.spec.id)
          continue
        }
      }
      const reg = this.managersInternal.triggers.register(record.spec, record.overlap, {
        ...(record.input !== undefined && { input: record.input }),
        ...(record.nextFireAt !== undefined && { restoredNextFireAt: record.nextFireAt }),
      })
      if (reg.lastError !== undefined) {
        process.stderr.write(
          `[skelm trigger] failed to restore dynamic schedule "${record.spec.id}": ${reg.lastError}\n`,
        )
      }
    }
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

  /**
   * Wrap the canonical audit writer with the SIEM/log-streaming forwarder when
   * `auditForwarding` is enabled. The forwarder is a read-side tee — it does
   * not become a second audit writer — and resolves each HTTP sink's bearer
   * credential through the gateway secret resolver. Best-effort: build failures
   * are logged and leave the unwrapped writer in place so audit never breaks.
   */
  private async wireAuditForwarding(): Promise<void> {
    if (this.enforcementInternal === null) return
    this.auditForwarderInternal = null
    const cfg = this.config.auditForwarding
    if (cfg?.enabled !== true || cfg.sinks === undefined || cfg.sinks.length === 0) return
    try {
      const sinks = await buildAuditSinks(cfg.sinks, this.enforcementInternal.secretResolver)
      if (sinks.length === 0) return
      const forwarder = new ForwardingAuditWriter(
        this.enforcementInternal.auditWriter,
        sinks,
        (err, _sink) => {
          console.warn(
            `gateway: audit forward failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        },
      )
      this.auditForwarderInternal = forwarder
      this.enforcementInternal = { ...this.enforcementInternal, auditWriter: forwarder }
    } catch (err) {
      console.warn(
        `gateway: audit forwarding setup failed; continuing without it: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  private async buildRegistries(): Promise<GatewayRegistries> {
    const watch = this.options.watchRegistries ?? true
    const workflows = new WorkflowRegistry({
      projectRoot: this.projectRoot,
      glob: this.config.registries?.workflows?.glob ?? 'workflows/**/*.workflow.{mts,ts}',
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
      ...(this.workflowArtifactInternal !== null && {
        artifactRoot: this.workflowArtifactInternal.artifactRoot,
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

  private async buildWorkflowArtifactService(): Promise<WorkflowArtifactService> {
    const { WorkflowArtifactService: Ctor } = await import(
      '../workflows/workflow-artifact-service.js'
    )
    return new Ctor({
      artifactRoot: join(this.stateDir, 'managed-workflows'),
      maxBytes: this.getWorkflowMaxArchiveBytes(),
    })
  }

  private attachSignals(): void {
    if (this.signalsAttached) return
    const stop = () => {
      void this.stop().catch((err: unknown) => {
        // Log + exit non-zero. Previously this catch was empty, so a stop
        // failure (lockfile error, port unbind, audit flush) left the
        // gateway half-down with no operator-visible signal. Force-exit so
        // systemd / supervisors see the failure and can restart.
        process.stderr.write(`gateway stop failed during signal: ${(err as Error).message}\n`)
        process.exit(1)
      })
    }
    const reload = () => {
      void this.reload().catch((err: unknown) => {
        process.stderr.write(`gateway reload failed: ${(err as Error).message}\n`)
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

// Drop `permissions` from a config `defaults` block. Used for the no-config
// fallback so the framework deny-all baseline is never applied as an operator
// permission ceiling (mirrors the CLI loader's deliberate exclusion).
function stripPermissionDefaults(
  defaults: NonNullable<SkelmConfig['defaults']>,
): NonNullable<SkelmConfig['defaults']> {
  const { permissions: _permissions, ...rest } = defaults
  return rest
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
