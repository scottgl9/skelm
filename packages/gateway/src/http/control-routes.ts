import { createHmac, timingSafeEqual } from 'node:crypto'
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
  setResponseHeader,
} from 'h3'
import type { GatewayContext } from '../lifecycle/gateway-types.js'
import { DEFAULT_WEBHOOK_DEDUPE_TTL_MS } from '../triggers/dedupe-store.js'
import { registerApprovalRoutes } from './routes/approvals.js'
import { registerAuditRoutes } from './routes/audit.js'
import { registerBatchRoutes } from './routes/batch.js'
import { registerChatRoutes } from './routes/chat.js'
import { registerConfigRoutes } from './routes/config.js'
import { registerDashboardRoutes } from './routes/dashboard.js'
import { registerDebugRoutes } from './routes/debug.js'
import { registerGatewayLifecycleRoutes } from './routes/gateway-lifecycle.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerMetricsRoutes } from './routes/metrics.js'
import { registerOpenAIRoutes } from './routes/openai.js'
import { registerPipelineRoutes } from './routes/pipelines.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerRunRoutes } from './routes/runs.js'
import { registerScheduleRoutes } from './routes/schedules.js'
import { registerSecretRoutes } from './routes/secrets.js'
import { registerSessionRoutes } from './routes/sessions.js'
import { registerWorkflowRoutes } from './routes/workflows.js'
import { registerWorkspaceRoutes } from './routes/workspaces.js'

const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1_048_576

/**
 * Mount the gateway control surface on an h3 app via a method-aware router.
 *
 * The auth middleware on the parent server applies to every route mounted here.
 * A Router (instead of bare app.use) is used so the explicit control routes
 * always win over the webhook dispatch fallback registered after.
 */
export function mountControlRoutes(app: App, gateway: GatewayContext): void {
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
  registerProjectRoutes(router, gateway)
  registerChatRoutes(router, gateway)
  registerScheduleRoutes(router, gateway)
  registerOpenAIRoutes(router, gateway)
  registerDashboardRoutes(router, gateway)
  registerWorkflowRoutes(router, gateway)
  registerBatchRoutes(router, gateway)
  registerConfigRoutes(router, gateway)
  registerAuditRoutes(router, gateway)
  registerWorkspaceRoutes(router, gateway)
  registerSecretRoutes(router, gateway)

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
      // MS Graph subscription validation: echo the token before any dispatch.
      if (reg.spec.provider === 'ms-graph' && method.toUpperCase() === 'GET') {
        const token = getMsGraphValidationToken(url)
        if (token !== null) {
          setResponseHeader(event, 'content-type', 'text/plain')
          return token
        }
      }
      // Webhooks need the raw body bytes before any JSON parse. Enforce the
      // cap while reading so chunked requests cannot bypass maxBodyBytes.
      const rawBody = await readWebhookRawBody(
        event,
        reg.spec.maxBodyBytes ?? DEFAULT_WEBHOOK_MAX_BODY_BYTES,
      )
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
            !verifySlackSignature(rawBody, signature, timestamp, reg.spec.secret)
          ) {
            throw createError({
              statusCode: 401,
              message: 'Slack signature verification failed',
            })
          }
        } else if (reg.spec.provider === undefined) {
          const verdict = verifySignature(
            event,
            rawBody,
            reg.spec.secret,
            reg.spec.replayWindowSeconds,
          )
          if (verdict !== 'ok') {
            throw createError({
              statusCode: 401,
              message: `webhook signature verification failed: ${verdict}`,
            })
          }
        } else {
          throw createError({ statusCode: 401, message: 'unsupported webhook secret provider' })
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
        body =
          reg.spec.provider === 'slack'
            ? rawBody === ''
              ? undefined
              : (JSON.parse(rawBody) as unknown)
            : parseJsonBody(rawBody)
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

async function readWebhookRawBody(event: H3Event, maxBytes: number): Promise<string> {
  const rawLength = event.headers.get('content-length')
  if (rawLength !== null && rawLength !== '') {
    const length = Number.parseInt(rawLength, 10)
    if (Number.isFinite(length) && length > maxBytes) {
      throw createError({ statusCode: 413, message: 'webhook payload too large' })
    }
  }
  const req = event.node.req
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      reject(err)
    }
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.byteLength
      if (total > maxBytes) {
        fail(createError({ statusCode: 413, message: 'webhook payload too large' }))
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', fail)
  })
}

function parseJsonBody(raw: string): unknown {
  if (raw === '') return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return { raw }
  }
}

function verifySignature(
  event: H3Event,
  rawBody: string,
  secret: string,
  replayWindowSeconds = 300,
): 'ok' | 'missing-signature' | 'missing-timestamp' | 'stale-timestamp' | 'bad-signature' {
  const sigHeader = event.headers.get('x-webhook-signature')
  if (sigHeader === null || sigHeader.length === 0) return 'missing-signature'
  const tsHeader = event.headers.get('x-webhook-timestamp')
  if (tsHeader === null || tsHeader.length === 0) return 'missing-timestamp'
  const ts = Number.parseInt(tsHeader, 10)
  if (!Number.isFinite(ts)) return 'missing-timestamp'
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts)
  if (skew > replayWindowSeconds) return 'stale-timestamp'
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')
  const provided = sigHeader.startsWith('sha256=') ? sigHeader.slice(7) : sigHeader
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(provided, 'hex')
  if (a.length !== b.length) return 'bad-signature'
  return timingSafeEqual(a, b) ? 'ok' : 'bad-signature'
}
