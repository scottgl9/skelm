import type { SkelmConfigAgentEntry, SkelmConfigMcpServerEntry } from '@skelm/core'
import { type Router, eventHandler } from 'h3'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'

export function registerRuntimeRoutes(router: Router, gateway: GatewayContext): void {
  router.get(
    '/v1/dashboard/runtime',
    eventHandler(async () => {
      const backends =
        gateway.backends?.list().map((backend) => ({
          id: backend.id,
          label: (backend as { label?: string }).label,
          capabilities: backend.capabilities,
          advisory: backend.capabilities.toolPermissions === 'advisory',
        })) ?? []
      return {
        gateway: {
          state: gateway.getState(),
          auth: gateway.getConfig().server?.auth?.mode ?? 'none',
          metricsEnabled: gateway.metrics !== null,
        },
        backends,
        advisoryBackends: backends
          .filter((backend) => backend.advisory)
          .map((backend) => backend.id),
        agents: gateway.registries.agents.list().map(summarizeAgentEntry),
        mcpServers: gateway.registries.mcpServers.list().map(summarizeMcpServerEntry),
        acpSessions: gateway.managers.acpSessions.list(),
        agentmemory: { enabled: gateway.getAgentmemoryClient() !== null },
      }
    }),
  )
}

interface RuntimeAgentSummary {
  id: string
  runtime: string
  lifecycle: 'resident' | 'ephemeral'
  endpoint: 'process' | 'remote'
  url?: string
  hasPermissions: boolean
}

interface RuntimeMcpServerSummary {
  id: string
  transport: 'stdio' | 'http' | 'sse'
  endpoint: 'process' | 'remote'
  url?: string
}

function summarizeAgentEntry(entry: SkelmConfigAgentEntry): RuntimeAgentSummary {
  return {
    id: entry.id,
    runtime: entry.runtime,
    lifecycle: entry.lifecycle,
    endpoint: entry.url !== undefined ? 'remote' : 'process',
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    hasPermissions: entry.permissions !== undefined,
  }
}

function summarizeMcpServerEntry(entry: SkelmConfigMcpServerEntry): RuntimeMcpServerSummary {
  return {
    id: entry.id,
    transport: entry.transport,
    endpoint: entry.url !== undefined ? 'remote' : 'process',
    ...(entry.url !== undefined ? { url: entry.url } : {}),
  }
}
