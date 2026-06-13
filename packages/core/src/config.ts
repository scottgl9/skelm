// skelm.config.ts surface. Customers import `defineConfig` from skelm
// and export a default value; the CLI walks up from cwd to find it.

import type { AgentPermissions, ExecutableProfileDefinition } from './permissions.js'

/**
 * Minimal duck-typed contract for queue-style trigger sources registered in
 * skelm.config.ts. Mirrors @skelm/gateway's QueueDriver — declared here so
 * @skelm/core has no dependency on the gateway package. The gateway accepts
 * any object satisfying this shape.
 */
export interface SkelmTriggerSource {
  start(opts: {
    config?: Record<string, unknown>
    onMessage: (payload?: unknown) => Promise<void>
  }): Promise<void> | void
  stop(): Promise<void> | void
  onResult?(payload: unknown, output: unknown): Promise<void> | void
}

export interface SkelmConfigTriggerSourceEntry {
  /** Identifier referenced by pipeline-declared `{ kind: 'queue', sourceId }` triggers. */
  id: string
  /** Pre-built source instance. */
  driver: SkelmTriggerSource
}

export interface SkelmConfigBackendEntry {
  /**
   * ACP-only permission mode. Defaults to `strict`, which fails closed when
   * skelm cannot enforce a declared permission policy. `advisory` must be
   * explicit and is surfaced in runtime diagnostics/audit metadata.
   */
  permissionMode?: 'strict' | 'advisory'
  /** Backend-specific configuration. The runtime forwards this to the backend factory. */
  [k: string]: unknown
}

export interface SkelmConfigBackends {
  default?: string
  infer?: string
  agent?: string
  [k: string]: SkelmConfigBackendEntry | string | undefined
}

export interface SkelmConfigSecrets {
  driver?: 'env' | 'file'
  /** When driver is 'file', path to the JSON file with secrets. */
  file?: string
}

/**
 * Audit log forwarding (SIEM / log-streaming). The gateway tees every audit
 * record the single chain writer commits to these sinks as a best-effort,
 * read-side forwarder — it never replaces or precedes the canonical write, and
 * a sink failure never breaks the audit write or the gateway loop.
 *
 * No secret value is ever forwarded: audit rows carry names + non-secret
 * metadata only, and the sink credential is referenced by name
 * (`headerSecretName`), resolved gateway-side, never written in config.
 */
export interface SkelmConfigAuditForwarding {
  /** When false (or omitted), no forwarder is wired. */
  enabled?: boolean
  /** One or more sinks to fan audit records out to. */
  sinks?: readonly SkelmConfigAuditSink[]
}

export type SkelmConfigAuditSink = SkelmConfigAuditHttpSink | SkelmConfigAuditFileSink

export interface SkelmConfigAuditHttpSink {
  kind: 'http'
  /** Destination URL; the JSON audit record is POSTed as the body. */
  url: string
  /** Static, non-secret headers (e.g. content-type, a tenant id). */
  headers?: Readonly<Record<string, string>>
  /**
   * Name of a secret resolved through the gateway's `SecretResolver` and sent
   * as `Authorization: Bearer <value>`. The value never appears in config,
   * logs, or audit.
   */
  headerSecretName?: string
  /** Per-request timeout in milliseconds. Defaults to 3000. */
  timeoutMs?: number
}

export interface SkelmConfigAuditFileSink {
  kind: 'file'
  /** Append-only JSON-Lines file the audit records are streamed to. */
  path: string
}

export interface SkelmConfigRunsStorage {
  driver?: 'sqlite' | 'memory' | 'postgres'
  /** Local sqlite file path; ignored for non-sqlite drivers. */
  path?: string
  /** Postgres connection URL; required when driver is 'postgres'. */
  url?: string
  /** Postgres schema for table namespace; defaults to `public`. */
  schema?: string
  /** Optional Postgres pool size override. */
  poolSize?: number
  /** Optional per-run artifact quota override. */
  artifactQuotaBytes?: number
}

export interface SkelmConfigStateStorage {
  driver?: 'sqlite' | 'memory'
  path?: string
}

export interface SkelmConfigStorage {
  runs?: SkelmConfigRunsStorage
  state?: SkelmConfigStateStorage
  workspaces?: { base?: string; ephemeralBase?: string }
}

export interface SkelmConfigServer {
  port?: number
  host?: string
  auth?: { mode: 'none' | 'bearer' }
  /** Bearer token for auth mode 'bearer'. If omitted, reads SKELM_TOKEN. */
  token?: string
  maxConcurrentRuns?: number
  proxy?: {
    /** Egress proxy port. Default: server.port + 1. */
    port?: number
    /** Enable the egress proxy. Default: true. */
    enabled?: boolean
  }
}

/**
 * Declarative entry for a coding agent or ACP agent the gateway will manage.
 * `lifecycle` selects between long-living (`resident`) and per-step (`ephemeral`)
 * supervision strategies — see planning/22 and the gateway-centric refactor.
 */
export interface SkelmConfigAgentEntry {
  id: string
  /** The runtime the agent uses (e.g. 'opencode', 'claude-code', 'pi', 'acp'). */
  runtime: string
  lifecycle: 'resident' | 'ephemeral'
  /** Spawn command for ephemeral agents or `serve` for resident ones. */
  command?: string
  args?: readonly string[]
  /** HTTP URL when the agent is reachable as a long-lived server. */
  url?: string
  env?: Readonly<Record<string, string>>
  /** Optional permissions narrowing applied to every step that uses this agent. */
  permissions?: AgentPermissions
  /** Free-form metadata forwarded to the supervisor. */
  metadata?: Readonly<Record<string, unknown>>
}

export interface SkelmConfigMcpServerEntry {
  id: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: readonly string[]
  url?: string
  env?: Readonly<Record<string, string>>
}

export interface SkelmConfigRegistries {
  /** Glob (relative to projectRoot) to scan for `*.workflow.ts` files. */
  workflows?: { glob?: string }
  /** Glob (relative to projectRoot) to scan for skill markdown documents. */
  skills?: { glob?: string }
  /** MCP servers the gateway hosts. Static config; FS-watched only via reload. */
  mcpServers?: readonly SkelmConfigMcpServerEntry[]
  /** Agents (coding + ACP) the gateway supervises. */
  agents?: readonly SkelmConfigAgentEntry[]
}

// Fields shared by both workflow and gateway configs (not exported — internal base).
interface SkelmConfigBase {
  /** Default backend id used by infer()/agent() steps that don't specify one. */
  backend?: string
  backends?: SkelmConfigBackends
  /**
   * Static environment variables applied at CLI / gateway startup. Merged
   * into `process.env` so subprocess steps (`ctx.exec`, coding agents, MCP
   * servers) inherit them. Precedence is `process.env > .env file > config.env`
   * — values already set in the parent process are never overwritten.
   *
   * Use this for non-secret defaults like LLM model names and base URLs.
   * For secrets, prefer a `secrets.driver` or a `.env` file under
   * `.gitignore`. The CLI loads `<projectRoot>/.env` automatically before
   * applying this map.
   */
  env?: Readonly<Record<string, string>>
}

/**
 * Workflow/project config — authored by workflow developers, project-local.
 * Use `defineWorkflowConfig` when authoring `skelm.config.ts`.
 */
export interface SkelmWorkflowConfig extends SkelmConfigBase {
  /**
   * Workflow file to run when `skelm run <dir>` targets this project's
   * directory. Resolved relative to the config file. When unset, `skelm run`
   * on a directory falls back to an `index.workflow.{mts,ts}` /
   * `index.pipeline.{mts,ts}` file or a single unambiguous workflow file.
   */
  entrypoint?: string
  /**
   * Pre-built backend instances. Use this when the backends map's string-keyed
   * config format is insufficient — e.g. a custom ACP backend with non-standard
   * options. Instances are registered by their `id` field.
   * Example: `instances: [createAcpBackend({ id: 'my-agent', command: 'my-cli' })]`
   */
  instances?: readonly import('./backend.js').SkelmBackend[]
  /** Project-level default permissions; per-step permissions intersect with these. */
  defaults?: {
    /** Default backend id. Equivalent to the top-level `backend` field; both are checked. */
    backend?: string
    permissions?: AgentPermissions
    permissionProfiles?: Readonly<Record<string, AgentPermissions>>
    /**
     * Named executable sets referenced by `permissions.executableProfiles`.
     * Definitions only — no profile is granted unless permissions reference
     * it by name.
     */
    executableProfiles?: Readonly<Record<string, ExecutableProfileDefinition>>
  }
  /** Workflow discovery configuration. */
  pipelines?: {
    discovery?: 'auto' | 'explicit'
    glob?: string
    explicit?: readonly string[]
  }
  /** Gateway registries — workflows, skills, MCP servers, agents. */
  registries?: SkelmConfigRegistries
  /**
   * Pre-built trigger sources (e.g. Telegram, Slack, an internal queue
   * client). Each entry's `id` is the value pipelines reference via
   * `triggers: [{ kind: 'queue', sourceId: '<id>' }]`. The gateway registers
   * these with the trigger coordinator at startup.
   */
  triggerSources?: readonly SkelmConfigTriggerSourceEntry[]
}

/**
 * Gateway/operator config — authored by operators, runtime-local.
 * Use `defineGatewayConfig` when authoring `skelm.gateway.ts`.
 */
export interface SkelmGatewayConfig extends SkelmConfigBase {
  defaults?: {
    /** Default backend id. Equivalent to the top-level `backend` field; both are checked. */
    backend?: string
    /** Gateway-wide permission baseline; intersected with per-project ceilings. */
    permissions?: AgentPermissions
    /** Named permission profiles available to all projects hosted by this gateway. */
    permissionProfiles?: Readonly<Record<string, AgentPermissions>>
    /**
     * Named executable sets referenced by `permissions.executableProfiles`,
     * available to all projects hosted by this gateway. Definitions only —
     * no profile is granted unless permissions reference it by name.
     */
    executableProfiles?: Readonly<Record<string, ExecutableProfileDefinition>>
    /**
     * Operator grant for the full permission bypass. Workflow / persistent-workflow
     * ids listed here may run `unrestricted` IF they also set
     * `permissions.requestUnrestricted`. Authors cannot self-escalate; only this
     * operator-side list (or the env var `SKELM_UNRESTRICTED_WORKFLOWS`,
     * comma-separated) flips the bypass on. Empty/omitted ⇒ no grants.
     *
     * SECURITY: a granted agent runs arbitrary exec/network/fs as the gateway
     * user. Grant only ids you fully trust. Every bypassed turn is audited via
     * a `permission.bypassed` event.
     */
    unrestrictedGrants?: readonly string[]
  }
  secrets?: SkelmConfigSecrets
  /** Audit log forwarding to external SIEM / log-streaming sinks. */
  auditForwarding?: SkelmConfigAuditForwarding
  storage?: SkelmConfigStorage
  server?: SkelmConfigServer
  /** Plugin package names loaded at gateway startup. */
  plugins?: readonly string[]
  /**
   * Optional agentmemory integration. When enabled, the gateway instantiates
   * an `@skelm/agentmemory` client and exposes a per-step `AgentmemoryHandle`
   * to backends through `BackendContext.agentmemory`. Per-step opt-in is
   * still required via `permissions.agentmemory`.
   */
  agentmemory?: SkelmConfigAgentmemory
}

/** Intersection of workflow and gateway config — the catch-all type for internal use and `defineConfig`. */
export type SkelmConfig = SkelmWorkflowConfig & SkelmGatewayConfig

/** Configuration block for the agentmemory integration. */
export interface SkelmConfigAgentmemory {
  /** When false (or omitted), no agentmemory handle is wired. */
  enabled?: boolean
  /** Base URL of the agentmemory server. Defaults to `http://localhost:3111`. */
  url?: string
  /**
   * Name of a secret resolved through the gateway's `SecretResolver` and sent
   * as `Authorization: Bearer <value>`. Optional; omit for unauthenticated
   * local servers.
   */
  secretName?: string
  /** Per-request timeout in milliseconds. Defaults to 3000. */
  timeoutMs?: number
}

/**
 * Identity helper that gives customers full IDE assistance when authoring
 * `skelm.config.ts`. The runtime calls this implicitly when it imports the
 * config; we never mutate the result.
 */
export function defineConfig(config: SkelmConfig): SkelmConfig {
  return Object.freeze({ ...config })
}

/**
 * Identity helper for `skelm.config.ts` — workflow/project config.
 * Enforces the project-only field set at the TypeScript level; use this
 * instead of `defineConfig` when authoring a project config.
 */
export function defineWorkflowConfig(config: SkelmWorkflowConfig): SkelmWorkflowConfig {
  return Object.freeze({ ...config })
}

/**
 * Identity helper for `skelm.gateway.ts` — gateway/operator runtime config.
 * Enforces the operator-only field set at the TypeScript level; use this
 * instead of `defineConfig` when authoring a gateway config.
 */
export function defineGatewayConfig(config: SkelmGatewayConfig): SkelmGatewayConfig {
  return Object.freeze({ ...config })
}

/**
 * Candidate workflow-project config basenames, in resolution order. Shared so
 * the CLI and the gateway activation service probe the same way and never drift.
 */
export const CONFIG_FILENAMES = [
  'skelm.config.mts',
  'skelm.config.ts',
  'skelm.config.js',
  'skelm.config.mjs',
] as const

/**
 * Candidate gateway config basenames, in resolution order.
 */
export const GATEWAY_CONFIG_FILENAMES = [
  'skelm.gateway.mts',
  'skelm.gateway.ts',
  'skelm.gateway.js',
  'skelm.gateway.mjs',
] as const

/** Default configuration used when no skelm.config.ts is found. */
export const DEFAULT_CONFIG: SkelmConfig = Object.freeze({
  backends: {
    infer: 'openai' as const,
    openai: {},
  },
  pipelines: { discovery: 'auto' as const, glob: 'workflows/**/*.workflow.{mts,ts}' },
  registries: {
    workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' },
    skills: { glob: 'skills/**/SKILL.md' },
    mcpServers: [],
    agents: [],
  },
  defaults: {
    permissions: {
      networkEgress: 'deny' as const,
      allowedExecutables: [],
      allowedTools: [],
      allowedSkills: [],
      allowedMcpServers: [],
      fsRead: [],
      fsWrite: [],
    },
  },
  secrets: { driver: 'env' as const },
  // Storage paths are intentionally unset in the default. The gateway
  // resolves runs.path to <stateDir>/runs.sqlite at startup so a caller that
  // sets stateDir (per-project, or per-test mkdtemp) does not have to also
  // override storage to avoid sharing one global file across runs. Users who
  // want a stable home-directory path can set it explicitly in their
  // skelm.config.ts.
  storage: {
    runs: { driver: 'sqlite' as const },
    state: { driver: 'sqlite' as const },
  },
  server: {
    port: 14738,
    host: '127.0.0.1',
    auth: { mode: 'none' as const },
    maxConcurrentRuns: 10,
    proxy: {
      enabled: true,
    },
  },
})
