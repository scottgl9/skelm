import {
  getMsGraphValidationToken,
  verifyMsGraphClientState,
  verifySlackSignature,
} from '@skelm/integrations'
import {
  type App,
  type H3Event,
  createError,
  createRouter,
  eventHandler,
  readBody,
  readRawBody,
  setResponseHeader,
} from 'h3'
import type { Gateway } from '../lifecycle/gateway.js'
import { DEFAULT_WEBHOOK_DEDUPE_TTL_MS } from '../triggers/dedupe-store.js'
import { registerApprovalRoutes } from './routes/approvals.js'
import { registerBatchRoutes } from './routes/batch.js'
import { registerConfigRoutes } from './routes/config.js'
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
  registerBatchRoutes(router, gateway)
  registerConfigRoutes(router, gateway)

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
      // Slack signs the raw body verbatim; capture it before any JSON parse.
      const slackRawBody =
        reg.spec.provider === 'slack' ? ((await readRawBody(event, 'utf8')) ?? '') : undefined
      if (reg.spec.secret !== undefined) {
        if (reg.spec.provider === 'slack') {
          const signature = event.headers.get('x-slack-signature')
          const timestamp = event.headers.get('x-slack-request-timestamp')
          const replayCutoff = Math.floor(Date.now() / 1000) - 5 * 60
          if (
            signature === null ||
            timestamp === null ||
            !/^\d+$/.test(timestamp) ||
            Number(timestamp) < replayCutoff ||
            !verifySlackSignature(slackRawBody ?? '', signature, timestamp, reg.spec.secret)
          ) {
            throw createError({
              statusCode: 401,
              message: 'Slack signature verification failed',
            })
          }
        } else {
          const provided = event.headers.get('x-webhook-secret')
          if (provided !== reg.spec.secret) {
            throw createError({ statusCode: 401, message: 'webhook secret mismatch' })
          }
        }
      }
      // MS Graph subscription validation: echo the token before any dispatch.
      if (reg.spec.provider === 'ms-graph' && method.toUpperCase() === 'GET') {
        const token = getMsGraphValidationToken(url)
        if (token !== null) {
          setResponseHeader(event, 'content-type', 'text/plain')
          return token
        }
      }
      if (reg.spec.dedupe !== undefined) {
        const headerName = reg.spec.dedupe.header.toLowerCase()
        const deliveryId = event.headers.get(headerName)
        if (deliveryId !== null && deliveryId !== '') {
          const ttlMs = reg.spec.dedupe.ttlMs ?? DEFAULT_WEBHOOK_DEDUPE_TTL_MS
          const fresh = gateway.managers.triggers.webhookDedupe.recordIfFresh(
            triggerId,
            deliveryId,
            ttlMs,
          )
          if (!fresh) {
            await gateway.enforcement.auditWriter.write({
              actor: 'gateway',
              action: 'webhook.deduped',
              details: {
                triggerId,
                header: reg.spec.dedupe.header,
                deliveryId,
              },
            })
            return { ok: true, triggerId, deduped: true }
          }
        }
      }
      // Capture the request body so webhook-triggered pipelines can take the
      // delivery payload (plus a small set of headers) as input. h3 swallows
      // body-read failures and returns undefined; we tolerate that and pass
      // payload: undefined like the legacy behaviour.
      let body: unknown
      try {
        if (slackRawBody !== undefined) {
          body = slackRawBody === '' ? undefined : (JSON.parse(slackRawBody) as unknown)
        } else {
          body = await readBody(event)
        }
      } catch {
        body = undefined
      }
      // Slack URL verification: echo the challenge without dispatching.
      if (
        reg.spec.provider === 'slack' &&
        body !== undefined &&
        typeof body === 'object' &&
        body !== null &&
        (body as { type?: unknown }).type === 'url_verification' &&
        typeof (body as { challenge?: unknown }).challenge === 'string'
      ) {
        return { challenge: (body as { challenge: string }).challenge }
      }
      // MS Graph clientState enforcement: the only secret on a Graph
      // notification — Graph does not sign payloads. Every entry under
      // `value` must echo the clientState the subscription was created with.
      if (reg.spec.provider === 'ms-graph' && reg.spec.clientState !== undefined) {
        const expected = reg.spec.clientState
        const value = (body as { value?: unknown } | undefined)?.value
        const ok =
          Array.isArray(value) &&
          value.length > 0 &&
          value.every((n) => verifyMsGraphClientState(n, expected))
        if (!ok) {
          throw createError({ statusCode: 401, message: 'Graph clientState mismatch' })
        }
      }
      const headers: Record<string, string> = {}
      for (const [k, v] of event.headers.entries()) headers[k.toLowerCase()] = v
      const payload =
        body === undefined
          ? undefined
          : { body, headers, path, method, deliveredAt: new Date().toISOString() }
      await gateway.managers.triggers.fire(triggerId, undefined, payload)
      return { ok: true, triggerId }
    }),
  )
}
