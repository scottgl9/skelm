import type { SkelmConfigAgentEntry } from '@skelm/core'
import { BaseRegistry } from './base.js'

export type AgentEntry = SkelmConfigAgentEntry

export interface AgentRegistryOptions {
  agents: readonly SkelmConfigAgentEntry[]
}

/**
 * Registry of agents (coding agents and ACP agents) declared in
 * skelm.config.ts. The `lifecycle` field on each entry selects between the
 * resident supervisor (long-living `serve` mode) and the ephemeral spawner
 * (run-once-per-step). The supervisors live in packages/gateway/managers/
 * (Phases 8–9); the registry only stores declarations.
 */
export class AgentRegistry extends BaseRegistry<AgentEntry> {
  constructor(private agents: readonly SkelmConfigAgentEntry[]) {
    super()
  }

  /** Replace the underlying config snapshot (used on gateway reload). */
  setAgents(agents: readonly SkelmConfigAgentEntry[]): void {
    this.agents = agents
  }

  protected async loadSnapshot(): Promise<AgentEntry[]> {
    return this.agents.map((a) => ({ ...a }))
  }

  static fromOptions(opts: AgentRegistryOptions): AgentRegistry {
    return new AgentRegistry(opts.agents)
  }
}
