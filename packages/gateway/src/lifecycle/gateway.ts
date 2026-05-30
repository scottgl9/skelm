import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type AgentmemoryAuditEvent,
  AgentmemoryClient,
  createAgentmemoryHandle,
} from '@skelm/agentmemory'
import {
  ALL_AGENTMEMORY_OPS,
  type AgentPermissions,
  type ApprovalGate,
  type AuditWriter,
  BackendRegistry,
  DEFAULT_CONFIG,
  EnvSecretResolver,
  EventBus,
  MemoryRunStore,
  type NetworkPolicy,
  NoopAuditWriter,
  PermissionResolver,
  type RunStore,
  Runner,
  type SecretResolver,
  type SkelmConfig,
  SqliteRunStore,
  WorkspaceManager,
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

// Re-exported under the local name for site readability; the canonical
// list lives in @skelm/core/permissions (ALL_AGENTMEMORY_OPS).
const AGENTMEMORY_OPS = ALL_AGENTMEMORY_OPS

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
  private workspaceManagerInternal: WorkspaceManager | null = null
  private httpServer: SkelmServer | null = null
  private egressProxy: EgressProxy | null = null
  private tokenPolicyStore: TokenPolicyMap | null = null
  private agentmemoryClient: AgentmemoryClient | null = null
  private readonly inFlightRuns = new Map<string, AbortController>()
  private readonly inFlightRunners = new Map<string, import('@skelm/core').Runner>()
  private metricsInternal: import('@skelm/metrics').MetricsCollector | null = null
  // Captured as a function reference (not the module itself) so production
  // bundles only pull in @opentelemetry/api when enableOtel is true.
  private otelAttach: ((events: import('@skelm/core').EventBus) => { dispose(): void }) | null =
    null
  private otelDisposers: Array<{ dispose(): void }> = []
  private metricsBus: import('@skelm/core').EventBus | null = null
  /** Single shared EventBus that every per-request Runner publishes into,
   *  and that GET /runs/:id/stream subscribes to. Lazily-constructed; the
   *  first reader or writer creates it. */
  private eventsBusInternal: import('@skelm/core').EventBus | null = null
  private readonly breakpointsInternal: import('../debug/breakpoint-registry.js').BreakpointRegistry
  private workflowRegistrationInternal: WorkflowRegistrationService | null = null
  private workflowArchiveInternal: WorkflowArchiveService | null = null
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
   * Subscribe an EventBus into the OpenTelemetry collector when
   * enableOtel:true. The dispatcher calls this alongside attachMetricsBus
   * so every run produces a `run:<pipelineId>` span and one `step:<id>`
   * span per step. No-ops when otel is disabled. Disposers are tracked
   * so stop() can unsubscribe.
   */
  attachOtelBus(bus: import('@skelm/core').EventBus): void {
    if (this.otelAttach === null) return
    this.otelDisposers.push(this.otelAttach(bus))
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
    const { runId } = this.#startRunnerAsync(pipeline, input, entry.path)
    return { runId }
  }

  /**
   * Async ad-hoc start by absolute workflow path. The caller (HTTP routes)
   * is responsible for validating the path against the loader trust boundary
   * before handing it here. Mirrors {@link startPipelineAsync} but for a file
   * that need not be in the workflow registry, so `POST /runs` and
   * `POST /pipelines/start-file` share one start path.
   */
  async startAdhocRunByFile(
    absolutePath: string,
    registryId: string,
    input: unknown,
  ): Promise<{ runId: string; pipelineId: string }> {
    const loader = this.getWorkflowLoader()
    if (loader === undefined) {
      throw startPipelineError(501, 'gateway has no workflow loader')
    }
    const pipeline = await loadPipelineFromPath(loader, registryId, absolutePath)
    const { runId } = this.#startRunnerAsync(pipeline, input, absolutePath)
    return { runId, pipelineId: pipeline.id }
  }

  #startRunnerAsync(
    pipeline: import('@skelm/core').Pipeline,
    input: unknown,
    workflowPath: string,
  ): { runId: string } {
    const enforcement = this.enforcement
    const runner = new Runner({
      approvalGate: enforcement.approvalGate,
      secretResolver: enforcement.secretResolver,
      auditWriter: enforcement.auditWriter,
      store: this.runStore,
      events: this.events,
      workspaceManager: this.workspaceManager,
      ...(this.backendsInternal !== undefined && { backends: this.backendsInternal }),
    })
    this.attachMetricsBus(runner.events)
    this.attachOtelBus(runner.events)
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
          workflowPath,
        }),
        pipelineRegistry: makeGatewayPipelineRegistry(this),
        ...this.defaultPermissionRunOptions(),
        ...this.egressRunOptions(),
        ...this.agentmemoryRunOptions(),
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

  /**
   * The egress-proxy wiring to pass into every `Runner.start()` the gateway
   * drives. Without it the runner's `hasEgressProxy` hint is false (so the
   * network dimension is treated as unenforceable for subprocess backends like
   * Pi RPC) AND subprocess steps spawn with no `HTTP_PROXY`, bypassing the
   * proxy entirely. The trigger dispatcher already supplies these; every
   * HTTP run path (`skelm run`, `/pipelines/:id/run`, `/v1/*`) must too.
   */
  egressRunOptions(): {
    registerEgressToken: (runId: string, stepId: string, policy: NetworkPolicy) => string
    unregisterEgressToken: (runId: string, stepId: string) => void
    getProxyEnv: (egressToken?: string) => Record<string, string> | undefined
  } {
    return {
      registerEgressToken: (runId, stepId, policy) =>
        this.registerEgressToken(runId, stepId, policy),
      unregisterEgressToken: (runId, stepId) => this.unregisterEgressToken(runId, stepId),
      getProxyEnv: (egressToken) => this.getProxyEnvVars(egressToken),
    }
  }

  /**
   * Run-options block exposing the agentmemory handle factory. Spread into
   * `runner.start(...)` alongside `egressRunOptions()` so backends receive
   * `BackendContext.agentmemory` when the integration is enabled AND the
   * step's resolved policy permits at least one agentmemory operation.
   * Returns an empty object when agentmemory is disabled.
   */
  agentmemoryRunOptions(): {
    agentmemoryHandleFactory?: import('@skelm/core').AgentmemoryHandleFactory
  } {
    const client = this.agentmemoryClient
    if (client === null) return {}
    const defaultProject = this.projectRoot
    // Capture the audit writer at factory-build time so each per-step handle
    // emits one audit row per agentmemory op into the same ChainAuditWriter
    // that records every other privileged action — the "exactly one audit
    // writer" invariant from AGENTS.md. Without this, memory ops were
    // invisible to `skelm audit query` and to compliance review.
    const auditWriter = this.enforcementInternal?.auditWriter
    return {
      agentmemoryHandleFactory: (ctx) => {
        // Optional per agent: only hand out a handle when the step's resolved
        // policy permits at least one agentmemory op. A step that didn't opt in
        // gets no handle at all, so the backend's memory hooks become a clean
        // no-op instead of calling into a handle that denies every op (which
        // would spew `permission.denied` events and waste work every turn).
        const anyAllowed = AGENTMEMORY_OPS.some((op) => ctx.canUseAgentmemory(op).allow)
        if (!anyAllowed) return undefined
        const eventsBus = ctx.events
        return createAgentmemoryHandle({
          client,
          canUseAgentmemory: ctx.canUseAgentmemory,
          defaultProject,
          runId: ctx.runId,
          stepId: ctx.stepId,
          ...(eventsBus !== undefined ? { events: (event) => eventsBus.publish(event) } : {}),
          ...(auditWriter !== undefined
            ? { audit: (event) => writeAgentmemoryAudit(auditWriter, event, ctx.runId) }
            : {}),
        })
      },
    }
  }

  /**
   * Project-default permissions to apply to every gateway-driven run. Spread
   * into `runner.start(...)` so a workflow's resolved policy intersects with the
   * operator's `config.defaults.permissions` ceiling (and named profiles).
   *
   * Only the operator's explicitly-declared defaults are applied — the merge in
   * the CLI loader never propagates the framework deny-all baseline, and the
   * gateway's no-config fallback strips it too, so an unset default stays
   * `undefined` (no narrowing) rather than denying every step.
   */
  defaultPermissionRunOptions(): {
    defaultPermissions?: AgentPermissions
    permissionProfiles?: Readonly<Record<string, AgentPermissions>>
  } {
    const defaults = this.config.defaults
    return {
      ...(defaults?.permissions !== undefined && { defaultPermissions: defaults.permissions }),
      ...(defaults?.permissionProfiles !== undefined && {
        permissionProfiles: defaults.permissionProfiles,
      }),
    }
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
          createTriggerDispatcher({
            gateway: this,
            loadWorkflow,
            ...(this.backendsInternal !== undefined && { backends: this.backendsInternal }),
          }),
        )
      }
      if (this.options.enableMetrics) {
        const { MetricsCollector } = await import('@skelm/metrics')
        this.metricsInternal = new MetricsCollector()
      }
      if (this.options.enableOtel) {
        // Captured behind a closure so the dynamic import only happens once
        // and per-run attach calls are synchronous (matches metrics).
        const { attachOpenTelemetry } = await import('@skelm/otel')
        this.otelAttach = (bus) => attachOpenTelemetry(bus)
      }
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
      if (gate instanceof SuspendApprovalGate) gate.drain('gateway stopping')
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
      // Unsubscribe every OTel attachment so spans stop being emitted and
      // the subscriber listeners on freed buses are released. Disposers
      // are individually try/catch'd via the `?.()` so a single failure
      // doesn't prevent the rest of stop() from running.
      for (const disposer of this.otelDisposers) {
        try {
          disposer.dispose()
        } catch {
          /* otel dispose failures must not block gateway stop */
        }
      }
      this.otelDisposers = []
      this.otelAttach = null
      this.metricsInternal = null
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

// Translate one AgentmemoryAuditEvent into an AuditEvent and fire-and-forget
// the write. The agentmemory handle invokes `audit(...)` synchronously (void
// return) but AuditWriter.write returns a Promise — we attach a no-op `.catch`
// so a writer failure can never surface as an unhandled rejection in the
// gateway's main loop. Action names mirror the event `type` (e.g.
// 'agentmemory.observe', 'agentmemory.session.start') so `skelm audit query
// --action 'agentmemory.*'` selects them cleanly.
function writeAgentmemoryAudit(
  writer: AuditWriter,
  event: AgentmemoryAuditEvent,
  runId: string | undefined,
): void {
  const { type, at: _at, ...details } = event
  void writer
    .write({
      timestamp: new Date(event.at).toISOString(),
      ...(runId !== undefined ? { runId } : {}),
      actor: 'agentmemory',
      action: type,
      details,
    })
    .catch(() => {
      /* audit writer failures are non-fatal for the agent loop */
    })
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
