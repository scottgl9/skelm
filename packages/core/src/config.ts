// skelm.config.ts surface. Customers import `defineConfig` from skelm
// and export a default value; the CLI walks up from cwd to find it.

import type { AgentPermissions } from './permissions.js'

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
  /** Project-level default permissions; per-step permissions intersect with these. */
  defaults?: {
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
  storage: {
    runs: { driver: 'sqlite' as const, path: '~/.skelm/runs.db' },
    state: { driver: 'sqlite' as const, path: '~/.skelm/runs.db' },
  },
  server: {
    port: 4000,
    host: '127.0.0.1',
    auth: { mode: 'none' as const },
    maxConcurrentRuns: 10,
  },
})
