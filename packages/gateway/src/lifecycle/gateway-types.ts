import type { AgentmemoryClient } from '@skelm/agentmemory'
import type {
  AgentPermissions,
  AgentmemoryHandleFactory,
  ApprovalGate,
  AuditWriter,
  BackendRegistry,
  EventBus,
  ExecutableProfileDefinition,
  NetworkPolicy,
  PermissionResolver,
  RunStore,
  Runner,
  SecretResolver,
  SkelmConfig,
  WorkspaceManager,
} from '@skelm/core'
import type { BreakpointRegistry } from '../debug/breakpoint-registry.js'
import type { AcpSessionManager } from '../managers/acp-session-manager.js'
import type { CodingAgentManager } from '../managers/coding-agent-manager.js'
import type { McpServerManager } from '../managers/mcp-server-manager.js'
import type {
  AgentRegistry,
  McpServerRegistry,
  SkillRegistry,
  WorkflowRegistry,
} from '../registries/index.js'
import type { TriggerCoordinator } from '../triggers/coordinator.js'
import type { WorkflowArchiveService } from '../workflows/workflow-archive-service.js'
import type { WorkflowArtifactService } from '../workflows/workflow-artifact-service.js'
import type { WorkflowRegistrationService } from '../workflows/workflow-registration-service.js'
import type { DiscoveryRecord } from './discovery.js'

export type GatewayState = 'stopped' | 'starting' | 'running' | 'paused' | 'stopping'

export interface GatewayOptions {
  /** Directory holding `gateway.lock` and `gateway.json`. Defaults to `~/.skelm`. */
  stateDir?: string
  /** Project root used to resolve registry globs. Defaults to `process.cwd()`. */
  projectRoot?: string
  /** Loaded config (with defaults applied). Defaults to DEFAULT_CONFIG. */
  config?: SkelmConfig
  /** Bound URL advertised in the discovery file. */
  url?: string
  /** Optional bearer token written into the discovery file. */
  token?: string
  /** Install OS signal handlers (SIGTERM/SIGINT/SIGHUP). Disabled in tests by default. */
  installSignalHandlers?: boolean
  /** Enable FS watching on the workflow / skill registries. Defaults to true. */
  watchRegistries?: boolean
  /** Shared backend registry. Workflows started via HTTP /pipelines/run-file,
   *  /pipelines/start-file, and the trigger dispatcher all draw from this
   *  registry. Without it, runs that reference a config-defined backend
   *  (e.g. `agent({ backend: 'pi' })`) fail with BackendNotFoundError. */
  backends?: BackendRegistry
  /** Override the canonical audit writer; defaults to NoopAuditWriter. */
  auditWriter?: AuditWriter
  /** Override the canonical secret resolver; defaults to env-backed. */
  secretResolver?: SecretResolver
  /** Override the canonical approval gate; defaults to auto-approve. */
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
   * Production wires this to native dynamic import(); tests can supply a fake.
   */
  loadWorkflow?: (registryId: string, absolutePath: string) => Promise<unknown>
  /**
   * Enable the Prometheus metrics collector and the GET /metrics endpoint.
   * The collector subscribes to run-event buses passed via
   * gateway.attachMetricsBus(); the route renders the current snapshot.
   */
  enableMetrics?: boolean
  /**
   * Enable OpenTelemetry tracing for runs and steps. When true, the gateway
   * subscribes to every per-run EventBus via the @skelm/otel collector,
   * emitting one span per run + one per step. The OTel SDK setup (exporter
   * / sampler / resource attributes) is the host's responsibility — by
   * default, spans are picked up by whatever global tracer provider the
   * host has registered (or a no-op tracer if none is registered).
   */
  enableOtel?: boolean
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
  /**
   * Additional directories outside the project root that are permitted as
   * `source.path` targets for POST /v1/workflows/register. Defaults to `[]`,
   * which means registration is limited to paths inside `projectRoot`.
   * Each entry is resolved to an absolute realpath before comparison.
   */
  allowedRegistrationDirs?: string[]
  /** Batch endpoint tunables. */
  batch?: {
    /** Maximum items per /v1/batch/runs request. Defaults to 50. */
    maxItemsPerRequest?: number
  }
  /** Workflow registration tunables. */
  workflows?: {
    /** Maximum uploaded .zip size in bytes. Defaults to 5 MiB. */
    maxArchiveBytes?: number
  }
  /**
   * Called after `gateway.reload()` finishes refreshing the registries.
   * Intended for the CLI to re-walk `pipelines[*].triggers` and register
   * any newly-declared triggers (and sweep orphans whose backing file is
   * gone). Without this, a `POST /gateway/reload` discovers the new
   * workflow but leaves its declared triggers unarmed.
   *
   * The gateway calls this once per reload, after registries are
   * refreshed and before reload() resolves. Errors are caught and
   * forwarded to console.error so a broken sync doesn't poison reload.
   */
  onReload?: () => Promise<void> | void
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
 * The contract the HTTP route layer depends on. All route handler functions
 * accept this interface rather than the concrete Gateway class so that the
 * HTTP layer and the lifecycle layer do not form a static import cycle.
 *
 * Gateway implements this interface (verified by the `implements` clause).
 */
export interface GatewayContext {
  // ── core stores / services ──────────────────────────────────────────────
  readonly stateDir: string
  /** Project root used to resolve registry globs and the workflow-package store. */
  readonly projectRoot: string
  readonly runStore: RunStore
  readonly events: EventBus
  readonly registries: GatewayRegistries
  readonly managers: GatewayManagers
  readonly enforcement: GatewayEnforcement
  readonly backends: BackendRegistry | undefined
  readonly workspaceManager: WorkspaceManager
  readonly breakpoints: BreakpointRegistry
  readonly metrics: import('@skelm/metrics').MetricsCollector | null
  readonly tasks: import('../tasks/task-service.js').TaskService
  /**
   * Store of issued scoped RBAC tokens. RBAC is opt-in and additive: when this
   * store holds no tokens, the gateway auth path stays on the legacy single
   * bearer token (which is ROOT). Owned by the gateway — the trust boundary.
   */
  readonly tokenStore: import('../auth/token-store.js').TokenStore

  // ── run lifecycle ────────────────────────────────────────────────────────
  cancel(runId: string, reason?: string): boolean
  getRunner(runId: string): Runner | undefined
  registerRun(runId: string, controller: AbortController, runner?: Runner): void
  unregisterRun(runId: string): void
  resumeWaitingRun(runId: string, resumeValue: unknown): Promise<void>
  startAdhocRunByFile(
    absolutePath: string,
    registryId: string,
    input: unknown,
  ): Promise<{ runId: string; pipelineId: string }>
  startPipelineAsync(
    pipelineId: string,
    input: unknown,
    lineage?: import('../execution/gateway-runtime.js').RunLineage,
  ): Promise<{ runId: string }>

  // ── pipeline / workflow loading ──────────────────────────────────────────
  getWorkflowLoader(): ((registryId: string, absolutePath: string) => Promise<unknown>) | undefined
  getWorkflowRegistrationService(): WorkflowRegistrationService
  getWorkflowArchiveService(): WorkflowArchiveService
  getWorkflowArtifactService(): WorkflowArtifactService
  getAllowedRegistrationDirs(): string[]
  getWorkflowMaxArchiveBytes(): number

  // ── scheduling ───────────────────────────────────────────────────────────
  persistDynamicSchedule(
    registration: import('../triggers/types.js').TriggerRegistration,
  ): Promise<void>
  deleteDynamicSchedule(id: string): Promise<void>

  // ── config / state ───────────────────────────────────────────────────────
  getConfig(): import('@skelm/core').SkelmConfig
  getDiscovery(): DiscoveryRecord | null
  getState(): GatewayState
  getAgentmemoryClient(): AgentmemoryClient | null

  // ── gateway control ──────────────────────────────────────────────────────
  reload(nextConfig?: import('@skelm/core').SkelmConfig): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>

  // ── observability ────────────────────────────────────────────────────────
  attachMetricsBus(bus: EventBus): void
  attachOtelBus(bus: EventBus): void

  // ── run option helpers ───────────────────────────────────────────────────
  getBatchMaxItemsPerRequest(): number
  egressRunOptions(): {
    registerEgressToken: (runId: string, stepId: string, policy: NetworkPolicy) => string
    unregisterEgressToken: (runId: string, stepId: string) => void
    getProxyEnv: (egressToken?: string) => Record<string, string> | undefined
  }
  agentmemoryRunOptions(): {
    agentmemoryHandleFactory?: AgentmemoryHandleFactory
  }
  defaultPermissionRunOptions(workflowId?: string): {
    defaultPermissions?: AgentPermissions
    permissionProfiles?: Readonly<Record<string, AgentPermissions>>
    executableProfiles?: Readonly<Record<string, ExecutableProfileDefinition>>
  }
  defaultBackendRunOptions(workflowId?: string): {
    defaultAgentBackend?: string
    defaultInferBackend?: string
  }
  isUnrestrictedGranted(workflowId: string): boolean
  absorbBackends(registry: BackendRegistry): {
    absorbed: string[]
    skipped: string[]
  }
  reinitAgentmemory(): Promise<void>
  registerWorkflowProjectPermissions(
    workflowId: string,
    permissions: {
      defaultPermissions?: AgentPermissions
      permissionProfiles?: Readonly<Record<string, AgentPermissions>>
      executableProfiles?: Readonly<Record<string, ExecutableProfileDefinition>>
    },
  ): void
  unregisterWorkflowProjectPermissions(workflowId: string): void
  registerWorkflowProjectBackends(
    workflowId: string,
    backends: {
      defaultAgentBackend?: string
      defaultInferBackend?: string
    },
  ): void
  unregisterWorkflowProjectBackends(workflowId: string): void
}
