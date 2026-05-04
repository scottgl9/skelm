import { type Pipeline, type RunEvent, Runner, describePipeline } from '@skelm/core'
import {
  type App,
  type H3Event,
  createError,
  createRouter,
  eventHandler,
  getQuery,
  readBody,
} from 'h3'
import type { Gateway } from '../lifecycle/gateway.js'

/**
 * Mount the gateway control surface on an h3 app via a method-aware router:
 * lifecycle (pause/resume/reload), approvals (list/approve/deny), sessions
 * (list/get/resume/delete), triggers (list/fire), and a /health probe.
 *
 * The auth middleware on the parent server applies to every route mounted
 * here. We use a Router (instead of bare app.use) because the existing
 * server registers prefix-matched handlers for /runs and /pipelines that
 * would otherwise shadow our /runs/:runId/approve route.
 */
export function mountControlRoutes(app: App, gateway: Gateway): void {
  // preemptive: false so unmatched paths fall through to the webhook
  // dispatch handler below (and any further fallback). Registered control
  // paths still win over the legacy server.ts /runs and /pipelines prefix
  // handlers because the router is mounted before them.
  const router = createRouter()
  // Per-(pipeline, idempotency-key) → runId map for /pipelines/:id/run.
  // Replays of the same key return the cached runId without re-running.
  const idempotency = new Map<string, string>()

  router.get(
    '/metrics',
    eventHandler(async (event: H3Event) => {
      const collector = gateway.metrics
      if (collector === null) {
        throw createError({
          statusCode: 404,
          message: 'metrics are not enabled (start the gateway with enableMetrics: true)',
        })
      }
      // Reflect live gateway gauges on each scrape.
      const gate = gateway.enforcement.approvalGate as { list?: () => unknown[] }
      if (typeof gate.list === 'function') {
        collector.setApprovalsPending(gate.list().length)
      }
      event.node.res.setHeader('content-type', 'text/plain; version=0.0.4')
      return collector.render()
    }),
  )

  router.get(
    '/debug/breakpoints',
    eventHandler(async () => ({ breakpoints: gateway.breakpoints.list() })),
  )
  router.post(
    '/debug/breakpoints',
    eventHandler(async (event: H3Event) => {
      const body = (await readBody(event).catch(() => ({}))) as { stepId?: unknown }
      if (typeof body.stepId !== 'string' || body.stepId === '') {
        throw createError({ statusCode: 400, message: 'stepId required' })
      }
      gateway.breakpoints.add(body.stepId)
      return { added: body.stepId }
    }),
  )
  router.delete(
    '/debug/breakpoints/:stepId',
    eventHandler(async (event: H3Event) => {
      const stepId = decodeMaybe(event.context.params?.stepId)
      if (!stepId) throw createError({ statusCode: 400, message: 'stepId required' })
      const removed = gateway.breakpoints.remove(stepId)
      if (!removed) throw createError({ statusCode: 404, message: 'breakpoint not set' })
      return { removed: stepId }
    }),
  )
  router.get(
    '/debug/runs',
    eventHandler(async () => ({ paused: gateway.breakpoints.listPaused() })),
  )
  router.post(
    '/debug/runs/:runId/release',
    eventHandler(async (event: H3Event) => {
      const runId = event.context.params?.runId
      if (!runId) throw createError({ statusCode: 400, message: 'runId required' })
      const released = gateway.breakpoints.release(runId)
      if (!released) {
        throw createError({ statusCode: 404, message: 'run is not paused at a breakpoint' })
      }
      return { released: runId }
    }),
  )

  router.get(
    '/health',
    eventHandler(async () => ({
      status: 'ok',
      pid: process.pid,
      state: gateway.getState(),
      stateDir: gateway.stateDir,
    })),
  )

  router.post(
    '/gateway/pause',
    eventHandler(async () => {
      try {
        await gateway.pause()
        return { state: gateway.getState() }
      } catch (err) {
        throw createError({ statusCode: 409, message: (err as Error).message })
      }
    }),
  )
  router.post(
    '/gateway/resume',
    eventHandler(async () => {
      try {
        await gateway.resume()
        return { state: gateway.getState() }
      } catch (err) {
        throw createError({ statusCode: 409, message: (err as Error).message })
      }
    }),
  )
  router.post(
    '/gateway/reload',
    eventHandler(async () => {
      await gateway.reload()
      return { state: gateway.getState() }
    }),
  )

  router.get(
    '/approvals',
    eventHandler(async () => {
      const gate = gateway.enforcement.approvalGate as {
        list?: () => Array<{ id: string; request: unknown; createdAt: string }>
      }
      if (typeof gate.list !== 'function') return []
      return gate.list()
    }),
  )

  router.post(
    '/runs/:runId/approve',
    eventHandler(async (event: H3Event) => deliverApproval(event, gateway, true)),
  )
  router.post(
    '/runs/:runId/deny',
    eventHandler(async (event: H3Event) => deliverApproval(event, gateway, false)),
  )

  router.get(
    '/sessions',
    eventHandler(async () => gateway.managers.acpSessions.list()),
  )
  router.post(
    '/sessions/:id/resume',
    eventHandler(async (event: H3Event) => {
      const id = event.context.params?.id
      if (!id) throw createError({ statusCode: 400, message: 'session id required' })
      const s = await gateway.managers.acpSessions.resume(id)
      if (s === undefined) {
        throw createError({ statusCode: 404, message: 'session not found or expired' })
      }
      return s
    }),
  )
  router.post(
    '/sessions/prune',
    eventHandler(async (event: H3Event) => {
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object'
          ? (rawBody as { expired?: unknown; olderThanMs?: unknown })
          : {}
      const opts: { expired?: boolean; olderThanMs?: number } = {}
      if (body.expired === true) opts.expired = true
      if (typeof body.olderThanMs === 'number') opts.olderThanMs = body.olderThanMs
      const removed = await gateway.managers.acpSessions.prune(opts)
      return { removed }
    }),
  )

  router.delete(
    '/sessions/:id',
    eventHandler(async (event: H3Event) => {
      const id = event.context.params?.id
      if (!id) throw createError({ statusCode: 400, message: 'session id required' })
      const ok = await gateway.managers.acpSessions.terminate(id)
      if (!ok) throw createError({ statusCode: 404, message: 'session not found' })
      return { ok: true }
    }),
  )

  router.delete(
    '/runs/:runId',
    eventHandler(async (event: H3Event) => {
      const runId = event.context.params?.runId
      if (!runId) throw createError({ statusCode: 400, message: 'runId required' })
      const cancelled = gateway.cancel(runId, 'cancelled via HTTP DELETE')
      if (!cancelled) {
        throw createError({
          statusCode: 404,
          message: 'run not in flight (already completed, or unknown to this gateway)',
        })
      }
      return { cancelled: true, runId }
    }),
  )

  router.get(
    '/pipelines',
    eventHandler(async () =>
      gateway.registries.workflows.list().map((entry) => ({ id: entry.id, file: entry.path })),
    ),
  )

  router.post(
    '/v1/chat/completions',
    eventHandler(async (event: H3Event) => {
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object'
          ? (rawBody as { model?: unknown; messages?: unknown })
          : {}
      if (typeof body.model !== 'string' || body.model === '') {
        throw createError({ statusCode: 400, message: 'model required' })
      }
      if (!Array.isArray(body.messages)) {
        throw createError({ statusCode: 400, message: 'messages must be an array' })
      }
      const final = await runPipelineSync(gateway, body.model, { messages: body.messages })
      const content = openaiContentFor(final.output)
      return {
        id: `chatcmpl-${final.runId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: final.status === 'completed' ? 'stop' : 'error',
          },
        ],
        ...(final.error !== undefined && {
          error: { message: final.error.message ?? String(final.error), type: 'pipeline_error' },
        }),
      }
    }),
  )

  router.post(
    '/v1/responses',
    eventHandler(async (event: H3Event) => {
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object'
          ? (rawBody as { model?: unknown; input?: unknown })
          : {}
      if (typeof body.model !== 'string' || body.model === '') {
        throw createError({ statusCode: 400, message: 'model required' })
      }
      const input = body.input
      const pipelineInput =
        typeof input === 'string'
          ? { messages: [{ role: 'user', content: input }] }
          : Array.isArray(input)
            ? { messages: input }
            : input !== undefined && typeof input === 'object'
              ? (input as Record<string, unknown>)
              : {}
      const final = await runPipelineSync(gateway, body.model, pipelineInput)
      const content = openaiContentFor(final.output)
      return {
        id: `resp-${final.runId}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: body.model,
        status: final.status === 'completed' ? 'completed' : 'failed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }],
        ...(final.error !== undefined && {
          error: { message: final.error.message ?? String(final.error) },
        }),
      }
    }),
  )

  router.post(
    '/pipelines/:id/run',
    eventHandler(async (event: H3Event) => {
      const id = decodeMaybe(event.context.params?.id)
      if (!id) throw createError({ statusCode: 400, message: 'pipeline id required' })
      const entry = gateway.registries.workflows.get(id)
      if (entry === undefined) {
        throw createError({ statusCode: 404, message: 'pipeline not found' })
      }
      const loader = gateway.getWorkflowLoader()
      if (loader === undefined) {
        throw createError({
          statusCode: 501,
          message: 'gateway has no workflow loader (cannot import workflow modules)',
        })
      }
      const idemKey = event.headers.get('idempotency-key')
      if (idemKey !== null) {
        const cached = idempotency.get(`${id}:${idemKey}`)
        if (cached !== undefined) {
          const state = await gateway.runStore.getRun(cached)
          if (state !== null) {
            return {
              runId: state.runId,
              status: state.status,
              output: state.output,
              ...(state.error !== undefined && { error: state.error }),
            }
          }
        }
      }
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object' ? (rawBody as { input?: unknown }) : {}
      const input = body.input ?? {}
      let mod: unknown
      try {
        mod = await loader(id, entry.path)
      } catch (err) {
        throw createError({
          statusCode: 500,
          message: `failed to load workflow: ${(err as Error).message}`,
        })
      }
      const pipeline = extractPipeline(mod)
      if (pipeline === undefined) {
        throw createError({
          statusCode: 422,
          message: 'workflow module did not export a default pipeline',
        })
      }
      const enforcement = gateway.enforcement
      const runner = new Runner({
        approvalGate: enforcement.approvalGate,
        secretResolver: enforcement.secretResolver,
        auditWriter: enforcement.auditWriter,
        store: gateway.runStore,
      })
      gateway.attachMetricsBus(runner.events)
      const controller = new AbortController()
      const runId = crypto.randomUUID()
      gateway.registerRun(runId, controller, runner)
      try {
        const handle = runner.start(pipeline as Parameters<Runner['start']>[0], input as never, {
          runId,
          signal: controller.signal,
        })
        const finalState = await handle.wait()
        if (idemKey !== null) idempotency.set(`${id}:${idemKey}`, finalState.runId)
        return {
          runId: finalState.runId,
          status: finalState.status,
          output: finalState.output,
          ...(finalState.error !== undefined && { error: finalState.error }),
        }
      } finally {
        gateway.unregisterRun(runId)
      }
    }),
  )

  router.post(
    '/pipelines/:id/start',
    eventHandler(async (event: H3Event) => {
      const id = decodeMaybe(event.context.params?.id)
      if (!id) throw createError({ statusCode: 400, message: 'pipeline id required' })
      const entry = gateway.registries.workflows.get(id)
      if (entry === undefined) {
        throw createError({ statusCode: 404, message: 'pipeline not found' })
      }
      const loader = gateway.getWorkflowLoader()
      if (loader === undefined) {
        throw createError({ statusCode: 501, message: 'gateway has no workflow loader' })
      }
      const idemKey = event.headers.get('idempotency-key')
      if (idemKey !== null) {
        const cached = idempotency.get(`${id}:${idemKey}`)
        if (cached !== undefined) {
          return { runId: cached, status: 'running' as const }
        }
      }
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object' ? (rawBody as { input?: unknown }) : {}
      const input = body.input ?? {}
      let mod: unknown
      try {
        mod = await loader(id, entry.path)
      } catch (err) {
        throw createError({
          statusCode: 500,
          message: `failed to load workflow: ${(err as Error).message}`,
        })
      }
      const pipeline = extractPipeline(mod)
      if (pipeline === undefined) {
        throw createError({
          statusCode: 422,
          message: 'workflow module did not export a default pipeline',
        })
      }
      const enforcement = gateway.enforcement
      const runner = new Runner({
        approvalGate: enforcement.approvalGate,
        secretResolver: enforcement.secretResolver,
        auditWriter: enforcement.auditWriter,
        store: gateway.runStore,
      })
      gateway.attachMetricsBus(runner.events)
      const controller = new AbortController()
      const runId = crypto.randomUUID()
      gateway.registerRun(runId, controller, runner)
      const handle = runner.start(pipeline as Parameters<Runner['start']>[0], input as never, {
        runId,
        signal: controller.signal,
      })
      // Fire and forget; cleanup on settle. Errors are still recorded by the
      // runner into the runStore, so callers polling GET /runs/:runId see
      // failed/cancelled status.
      void handle
        .wait()
        .catch(() => {})
        .finally(() => gateway.unregisterRun(runId))
      if (idemKey !== null) idempotency.set(`${id}:${idemKey}`, runId)
      return { runId, status: 'running' as const }
    }),
  )

  router.post(
    '/runs/:runId/resume',
    eventHandler(async (event: H3Event) => {
      const runId = event.context.params?.runId
      if (!runId) throw createError({ statusCode: 400, message: 'runId required' })
      const runner = gateway.getRunner(runId)
      if (runner === undefined) {
        throw createError({
          statusCode: 404,
          message: 'no in-flight runner for runId (already completed, or unknown to this gateway)',
        })
      }
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object' ? (rawBody as { output?: unknown }) : {}
      try {
        await runner.resume(runId, body.output ?? {})
        return { resumed: true, runId }
      } catch (err) {
        throw createError({ statusCode: 400, message: (err as Error).message })
      }
    }),
  )

  router.get(
    '/pipelines/:id',
    eventHandler(async (event: H3Event) => {
      const raw = event.context.params?.id
      if (!raw) throw createError({ statusCode: 400, message: 'pipeline id required' })
      // Workflow ids contain slashes (e.g. workflows/foo.workflow.ts), which
      // callers URL-encode to fit a single path segment. Decode here.
      let id: string
      try {
        id = decodeURIComponent(raw)
      } catch {
        id = raw
      }
      const entry = gateway.registries.workflows.get(id)
      if (entry === undefined) {
        throw createError({ statusCode: 404, message: 'pipeline not found' })
      }
      const loader = gateway.getWorkflowLoader()
      if (loader === undefined) {
        // No loader configured: return registry metadata only, no graph.
        return { id: entry.id, file: entry.path, graph: null, input: null, output: null }
      }
      let mod: unknown
      try {
        mod = await loader(id, entry.path)
      } catch (err) {
        throw createError({
          statusCode: 500,
          message: `failed to load workflow: ${(err as Error).message}`,
        })
      }
      const pipeline = extractPipeline(mod)
      if (pipeline === undefined) {
        throw createError({
          statusCode: 422,
          message: 'workflow module did not export a default pipeline',
        })
      }
      const desc = describePipeline(pipeline)
      const [inputSchema, outputSchema] = await Promise.all([
        tryToJsonSchema((pipeline as { inputSchema?: unknown }).inputSchema),
        tryToJsonSchema((pipeline as { outputSchema?: unknown }).outputSchema),
      ])
      return {
        id: desc.id,
        file: entry.path,
        ...(desc.description !== undefined && { description: desc.description }),
        ...(desc.version !== undefined && { version: desc.version }),
        graph: { steps: desc.steps },
        input: inputSchema,
        output: outputSchema,
      }
    }),
  )

  router.get(
    '/runs/:runId/events',
    eventHandler(async (event: H3Event) => {
      const runId = event.context.params?.runId
      if (!runId) throw createError({ statusCode: 400, message: 'runId required' })
      const state = await gateway.runStore.getRun(runId)
      if (state === null) throw createError({ statusCode: 404, message: 'Run not found' })

      const query = getQuery(event)
      const opts: { since?: number; limit?: number } = {}
      const sinceRaw = query.since
      const limitRaw = query.limit
      if (typeof sinceRaw === 'string') {
        const since = Number.parseInt(sinceRaw, 10)
        if (!Number.isNaN(since)) opts.since = since
      }
      if (typeof limitRaw === 'string') {
        const limit = Number.parseInt(limitRaw, 10)
        if (!Number.isNaN(limit)) opts.limit = limit
      }

      const events: RunEvent[] = []
      for await (const e of gateway.runStore.listEvents(runId, opts)) {
        events.push(e)
      }
      return { runId, events }
    }),
  )

  router.get(
    '/triggers',
    eventHandler(async () => gateway.managers.triggers.list()),
  )
  router.post(
    '/triggers/:id/fire',
    eventHandler(async (event: H3Event) => {
      const id = event.context.params?.id
      if (!id) throw createError({ statusCode: 400, message: 'trigger id required' })
      await gateway.managers.triggers.fire(id)
      return { ok: true }
    }),
  )

  router.get(
    '/schedules',
    eventHandler(async () => {
      return gateway.managers.triggers.list().map((reg) => registrationToSchedule(reg))
    }),
  )

  router.post(
    '/schedules',
    eventHandler(async (event: H3Event) => {
      const body = (await readBody(event).catch(() => ({}))) as Record<string, unknown>
      const id = body.id
      const workflowId = body.workflowId
      const trigger = body.trigger as { kind?: string } | undefined
      if (typeof id !== 'string' || id === '') {
        throw createError({ statusCode: 400, message: 'id required' })
      }
      if (typeof workflowId !== 'string' || workflowId === '') {
        throw createError({ statusCode: 400, message: 'workflowId required' })
      }
      if (trigger === undefined || typeof trigger.kind !== 'string') {
        throw createError({ statusCode: 400, message: 'trigger.kind required' })
      }
      const overlap = (body.overlap as 'skip' | 'queue' | 'cancel' | undefined) ?? 'skip'
      const spec = scheduleTriggerToSpec(id, workflowId, trigger as { kind: string })
      if (spec === 'invalid') {
        throw createError({ statusCode: 400, message: 'invalid trigger configuration' })
      }
      const reg = gateway.managers.triggers.register(spec, overlap)
      if (reg.lastError !== undefined) {
        throw createError({
          statusCode: 400,
          message: `failed to register: ${reg.lastError}`,
        })
      }
      return registrationToSchedule(reg)
    }),
  )

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

/**
 * Best-effort conversion of a standard-schema-compatible schema into a JSON
 * Schema object. Detects the schema vendor via the `~standard.vendor` tag and
 * dynamic-imports the converter so the gateway does not hard-depend on any
 * one schema library.
 *
 * Currently understands Zod (via z.toJSONSchema, Zod 4+). Other vendors
 * return null; callers receive null and can document the gap.
 */
async function tryToJsonSchema(schema: unknown): Promise<unknown | null> {
  if (typeof schema !== 'object' || schema === null) return null
  const standard = (schema as { '~standard'?: { vendor?: unknown } })['~standard']
  const vendor = standard?.vendor
  if (vendor === 'zod') {
    try {
      const z = (await import('zod')) as {
        toJSONSchema?: (s: unknown) => unknown
        default?: { toJSONSchema?: (s: unknown) => unknown }
      }
      const fn = z.toJSONSchema ?? z.default?.toJSONSchema
      if (typeof fn !== 'function') return null
      return fn(schema)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Run a pipeline synchronously through the gateway runner stack.
 * Used by both /pipelines/:id/run and the /v1/* OpenAI-compat routes
 * to share the load-and-run pipeline. Throws createError(...) on
 * non-2xx conditions so h3 surfaces the right HTTP status.
 */
async function runPipelineSync(
  gateway: Gateway,
  pipelineId: string,
  input: unknown,
): Promise<{
  runId: string
  status: string
  output: unknown
  error?: { name?: string; message?: string }
}> {
  const entry = gateway.registries.workflows.get(pipelineId)
  if (entry === undefined) {
    throw createError({ statusCode: 404, message: `pipeline not found: ${pipelineId}` })
  }
  const loader = gateway.getWorkflowLoader()
  if (loader === undefined) {
    throw createError({ statusCode: 501, message: 'gateway has no workflow loader' })
  }
  let mod: unknown
  try {
    mod = await loader(pipelineId, entry.path)
  } catch (err) {
    throw createError({
      statusCode: 500,
      message: `failed to load workflow: ${(err as Error).message}`,
    })
  }
  const pipeline = extractPipeline(mod)
  if (pipeline === undefined) {
    throw createError({ statusCode: 422, message: 'workflow module did not export a default pipeline' })
  }
  const enforcement = gateway.enforcement
  const runner = new Runner({
    approvalGate: enforcement.approvalGate,
    secretResolver: enforcement.secretResolver,
    auditWriter: enforcement.auditWriter,
    store: gateway.runStore,
  })
  gateway.attachMetricsBus(runner.events)
  const controller = new AbortController()
  const runId = crypto.randomUUID()
  gateway.registerRun(runId, controller, runner)
  try {
    const handle = runner.start(
      pipeline as Parameters<Runner['start']>[0],
      input as never,
      { runId, signal: controller.signal },
    )
    const final = await handle.wait()
    return {
      runId: final.runId,
      status: final.status,
      output: final.output,
      ...(final.error !== undefined && { error: final.error }),
    }
  } finally {
    gateway.unregisterRun(runId)
  }
}

/**
 * Coerce a pipeline output into a string for OpenAI-shape responses.
 * - { content: string } → content
 * - { text: string } → text
 * - string → as-is
 * - anything else → JSON.stringify
 */
function openaiContentFor(output: unknown): string {
  if (typeof output === 'string') return output
  if (output !== null && typeof output === 'object') {
    const o = output as Record<string, unknown>
    if (typeof o.content === 'string') return o.content
    if (typeof o.text === 'string') return o.text
  }
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

function decodeMaybe(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function extractPipeline(mod: unknown): Pipeline | undefined {
  if (isPipelineish(mod)) return mod as Pipeline
  if (typeof mod === 'object' && mod !== null) {
    const m = mod as Record<string, unknown>
    if (isPipelineish(m.default)) return m.default as Pipeline
  }
  return undefined
}

function isPipelineish(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return Array.isArray(v.steps) && typeof v.id === 'string'
}

function scheduleTriggerToSpec(
  id: string,
  workflowId: string,
  trigger: { kind: string } & Record<string, unknown>,
): import('../triggers/types.js').TriggerSpec | 'invalid' {
  switch (trigger.kind) {
    case 'immediate':
      return { kind: 'immediate', id, workflowId }
    case 'at': {
      const when = trigger.when
      if (typeof when !== 'string') return 'invalid'
      return { kind: 'at', id, workflowId, when }
    }
    case 'cron': {
      const expr = trigger.expression
      if (typeof expr !== 'string') return 'invalid'
      return { kind: 'cron', id, workflowId, cron: expr }
    }
    case 'interval': {
      const everyMs = trigger.everyMs
      if (typeof everyMs !== 'number') return 'invalid'
      return { kind: 'interval', id, workflowId, everyMs }
    }
    case 'webhook': {
      const path = trigger.path
      if (typeof path !== 'string' || path === '') return 'invalid'
      const spec: import('../triggers/types.js').TriggerSpec = {
        kind: 'webhook',
        id,
        workflowId,
        path,
      }
      if (typeof trigger.method === 'string') spec.method = trigger.method
      if (typeof trigger.secret === 'string') spec.secret = trigger.secret
      return spec
    }
    case 'poll': {
      const everyMs = trigger.everyMs
      const sourceFnId = trigger.sourceFnId
      if (typeof everyMs !== 'number' || typeof sourceFnId !== 'string') return 'invalid'
      const spec: import('../triggers/types.js').TriggerSpec = {
        kind: 'poll',
        id,
        workflowId,
        everyMs,
        sourceFnId,
      }
      if (typeof trigger.dedupeKeyFnId === 'string') spec.dedupeKeyFnId = trigger.dedupeKeyFnId
      return spec
    }
    case 'queue': {
      const driver = trigger.driver
      if (typeof driver !== 'string') return 'invalid'
      const spec: import('../triggers/types.js').TriggerSpec = {
        kind: 'queue',
        id,
        workflowId,
        driver,
      }
      if (typeof trigger.config === 'object' && trigger.config !== null) {
        spec.config = trigger.config as Record<string, unknown>
      }
      return spec
    }
    default:
      return 'invalid'
  }
}

function registrationToSchedule(reg: import('../triggers/types.js').TriggerRegistration): {
  id: string
  workflowId: string
  trigger: Record<string, unknown>
  overlap: string
  enabled: boolean
  fired: number
  inflight: boolean
  lastFiredAt?: string
  lastError?: string
} {
  const spec = reg.spec
  let trigger: Record<string, unknown>
  switch (spec.kind) {
    case 'cron':
      trigger = { kind: 'cron', expression: spec.cron }
      break
    case 'interval':
      trigger = { kind: 'interval', everyMs: spec.everyMs }
      break
    case 'manual':
      trigger = { kind: 'manual' }
      break
    case 'immediate':
      trigger = { kind: 'immediate' }
      break
    case 'at':
      trigger = { kind: 'at', when: spec.when }
      break
    case 'webhook':
      trigger = { kind: 'webhook', path: spec.path }
      if (spec.method !== undefined) trigger.method = spec.method
      // Don't expose the secret on read.
      break
    case 'poll':
      trigger = { kind: 'poll', everyMs: spec.everyMs, sourceFnId: spec.sourceFnId }
      if (spec.dedupeKeyFnId !== undefined) trigger.dedupeKeyFnId = spec.dedupeKeyFnId
      break
    case 'queue':
      trigger = { kind: 'queue', driver: spec.driver }
      if (spec.config !== undefined) trigger.config = spec.config
      break
  }
  const out: ReturnType<typeof registrationToSchedule> = {
    id: spec.id,
    workflowId: spec.workflowId,
    trigger,
    overlap: reg.overlap,
    enabled: true,
    fired: reg.fired,
    inflight: reg.inflight,
  }
  if (reg.lastFiredAt !== undefined) out.lastFiredAt = reg.lastFiredAt
  if (reg.lastError !== undefined) out.lastError = reg.lastError
  return out
}

async function deliverApproval(
  event: H3Event,
  gateway: Gateway,
  approve: boolean,
): Promise<{ delivered: boolean }> {
  const runId = event.context.params?.runId
  if (!runId) throw createError({ statusCode: 400, message: 'runId required' })
  const body = (await readBody(event).catch(() => ({}))) as {
    stepId?: string
    approver?: string
    reason?: string
  }
  if (!body.stepId) throw createError({ statusCode: 400, message: 'stepId required' })
  const id = `${runId}:${body.stepId}`
  const gate = gateway.enforcement.approvalGate as {
    approve?: (id: string, approver?: string, reason?: string) => boolean
    deny?: (id: string, approver?: string, reason?: string) => boolean
  }
  const fn = approve ? gate.approve : gate.deny
  if (typeof fn !== 'function') {
    throw createError({ statusCode: 501, message: 'configured approval gate is not interactive' })
  }
  const delivered = fn.call(gate, id, body.approver, body.reason)
  if (!delivered) throw createError({ statusCode: 404, message: 'no pending approval' })
  return { delivered }
}
