import { type App, type H3Event, createError, createRouter, eventHandler } from 'h3'
import type { Gateway } from '../lifecycle/gateway.js'
import { registerApprovalRoutes } from './routes/approvals.js'
import { registerDashboardRoutes } from './routes/dashboard.js'
import { registerDebugRoutes } from './routes/debug.js'
import { registerGatewayLifecycleRoutes } from './routes/gateway-lifecycle.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerMetricsRoutes } from './routes/metrics.js'
import { registerOpenAIRoutes } from './routes/openai.js'
import { registerPipelineRoutes } from './routes/pipelines.js'
import { registerRunRoutes } from './routes/runs.js'
import { registerScheduleRoutes } from './routes/schedules.js'
import { registerSessionRoutes } from './routes/sessions.js'
import { registerWorkflowRoutes } from './routes/workflows.js'

/**
 * Mount the gateway control surface on an h3 app via a method-aware router.
 *
 * The auth middleware on the parent server applies to every route mounted here.
 * A Router (instead of bare app.use) is used so the explicit control routes
 * always win over the webhook dispatch fallback registered after.
 */
export function mountControlRoutes(app: App, gateway: Gateway): void {
  // preemptive: false so unmatched paths fall through to the webhook handler.
  const router = createRouter()

  registerMetricsRoutes(router, gateway)
  registerDebugRoutes(router, gateway)
  registerHealthRoutes(router, gateway)
  registerGatewayLifecycleRoutes(router, gateway)
  registerApprovalRoutes(router, gateway)
  registerSessionRoutes(router, gateway)
  registerRunRoutes(router, gateway)
  registerPipelineRoutes(router, gateway)
  registerScheduleRoutes(router, gateway)
  registerOpenAIRoutes(router, gateway)
  registerDashboardRoutes(router, gateway)
  registerWorkflowRoutes(router, gateway)

  app.use(router)

  // Webhook trigger dispatch: handled outside the router so paths registered
  // dynamically by webhook triggers can route through. Mounted after the
  // control router so explicit control routes always win.
  app.use(
    eventHandler(async (event: H3Event) => {
      const url = event.node.req.url ?? ''
      const method = event.node.req.method ?? 'GET'
      const path = url.split('?')[0] ?? ''
      const triggerId = gateway.managers.triggers.resolveWebhook(path, method)
      if (triggerId === undefined) return
      const reg = gateway.managers.triggers.get(triggerId)
      if (reg === undefined || reg.spec.kind !== 'webhook') return
      if (reg.spec.secret !== undefined) {
        const provided = event.headers.get('x-webhook-secret')
        if (provided !== reg.spec.secret) {
          throw createError({ statusCode: 401, message: 'webhook secret mismatch' })
        }
      }
      await gateway.managers.triggers.fire(triggerId)
      return { ok: true, triggerId }
    }),
  )
}
