// skelm.config.ts surface. Customers import `defineConfig` from skelm
// and export a default value; the CLI walks up from cwd to find it.

import type { AgentPermissions } from './permissions.js'

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
  /** Backend-specific configuration. The runtime forwards this to the backend factory. */
  [k: string]: unknown
}

export interface SkelmConfigBackends {
  default?: string
  llm?: string
  agent?: string
  [k: string]: SkelmConfigBackendEntry | string | undefined
}

export interface SkelmConfigSecrets {
  driver?: 'env' | 'file'
  /** When driver is 'file', path to the JSON file with secrets. */
  file?: string
}

export interface SkelmConfigStorage {
  runs?: { driver?: 'sqlite' | 'memory'; path?: string }
  state?: { driver?: 'sqlite' | 'memory'; path?: string }
  workspaces?: { base?: string; ephemeralBase?: string }
}

export interface SkelmConfigServer {
  port?: number
  host?: string
  auth?: { mode: 'none' | 'bearer' }
  maxConcurrentRuns?: number
  /**
   * Embedded CONNECT proxy for real `networkEgress` enforcement.
   * Defaults to enabled on port `server.port + 1` (14739 when port is 14738).
   */
  proxy?: {
    /** Proxy listen port. Defaults to server.port + 1. */
    port?: number
    /** Set to false to disable the proxy entirely. Defaults to true. */
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

export interface SkelmConfig {
  /** Default backend id used by llm()/agent() steps that don't specify one. */
  backend?: string
  backends?: SkelmConfigBackends
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
  }
  /** Workflow discovery configuration. */
  pipelines?: {
    discovery?: 'auto' | 'explicit'
    glob?: string
    explicit?: readonly string[]
  }
  /** Gateway registries — workflows, skills, MCP servers, agents. */
  registries?: SkelmConfigRegistries
  secrets?: SkelmConfigSecrets
  storage?: SkelmConfigStorage
  server?: SkelmConfigServer
  /** Plugin package names loaded at gateway startup. */
  plugins?: readonly string[]
  /**
   * Pre-built trigger sources (e.g. Telegram, Slack, an internal queue
   * client). Each entry's `id` is the value pipelines reference via
   * `triggers: [{ kind: 'queue', sourceId: '<id>' }]`. The gateway registers
   * these with the trigger coordinator at startup.
   */
  triggerSources?: readonly SkelmConfigTriggerSourceEntry[]
}

/**
 * Identity helper that gives customers full IDE assistance when authoring
 * `skelm.config.ts`. The runtime calls this implicitly when it imports the
 * config; we never mutate the result.
 */
export function defineConfig(config: SkelmConfig): SkelmConfig {
  return Object.freeze({ ...config })
}

/** Default configuration used when no skelm.config.ts is found. */
export const DEFAULT_CONFIG: SkelmConfig = Object.freeze({
  backends: {
    llm: 'openai' as const,
    openai: {},
  },
  pipelines: { discovery: 'auto' as const, glob: 'workflows/**/*.workflow.ts' },
  registries: {
    workflows: { glob: 'workflows/**/*.workflow.ts' },
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
  },
})
