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
}

export interface SkelmConfigServer {
  port?: number
  host?: string
  auth?: { mode: 'none' | 'bearer' }
  maxConcurrentRuns?: number
}

export interface SkelmConfig {
  /** Default backend id used by llm()/agent() steps that don't specify one. */
  backend?: string
  backends?: SkelmConfigBackends
  /** Project-level default permissions; per-step permissions intersect with these. */
  defaults?: { permissions?: AgentPermissions }
  /** Workflow discovery configuration. */
  pipelines?: {
    discovery?: 'auto' | 'explicit'
    glob?: string
    explicit?: readonly string[]
  }
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
  server: {
    port: 4000,
    host: '127.0.0.1',
    auth: { mode: 'none' as const },
    maxConcurrentRuns: 10,
  },
})
