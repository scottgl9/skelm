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
        agents: gateway.registries.agents.list(),
        mcpServers: gateway.registries.mcpServers.list(),
        acpSessions: gateway.managers.acpSessions.list(),
        agentmemory: { enabled: gateway.getAgentmemoryClient() !== null },
      }
    }),
  )
}
