import type { SkelmConfigMcpServerEntry } from '@skelm/core'
import { BaseRegistry } from './base.js'

export type McpServerEntry = SkelmConfigMcpServerEntry

export interface McpServerRegistryOptions {
  servers: readonly SkelmConfigMcpServerEntry[]
}

/**
 * Registry of MCP servers declared in skelm.config.ts. The McpServerManager
 * (Phase 7) reads from this registry to spawn shared stdio servers and
 * expose per-run handles. Static config; reloaded with the rest of the
 * gateway state on SIGHUP.
 */
export class McpServerRegistry extends BaseRegistry<McpServerEntry> {
  constructor(private servers: readonly SkelmConfigMcpServerEntry[]) {
    super()
  }

  setServers(servers: readonly SkelmConfigMcpServerEntry[]): void {
    this.servers = servers
  }

  protected async loadSnapshot(): Promise<McpServerEntry[]> {
    return this.servers.map((s) => ({ ...s }))
  }

  static fromOptions(opts: McpServerRegistryOptions): McpServerRegistry {
    return new McpServerRegistry(opts.servers)
  }
}
