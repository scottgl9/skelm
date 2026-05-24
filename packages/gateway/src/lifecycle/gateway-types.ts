import type {
  ApprovalGate,
  AuditWriter,
  BackendRegistry,
  PermissionResolver,
  RunStore,
  SecretResolver,
  SkelmConfig,
} from '@skelm/core'

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
  /** Shared backend registry. Workflows started via HTTP /pipelines/run-file,
   *  /pipelines/start-file, and the trigger dispatcher all draw from this
   *  registry. Without it, runs that reference a config-defined backend
   *  (e.g. `agent({ backend: 'pi' })`) fail with BackendNotFoundError. */
  backends?: BackendRegistry
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
