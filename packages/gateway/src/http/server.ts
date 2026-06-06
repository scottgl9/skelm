// Public HTTP entry point. Routes that need gateway-only state (pipeline
// graph + JSON Schema serialization, durable event listing, run cancel via
// AbortController, schedule registration) are owned by control-routes.ts
// and mounted before the routes here when a gateway is supplied — see
// mountControlRoutes below. Without a gateway this surface is intentionally
// narrower; embedded callers reach those features through the gateway.

import { timingSafeStringEqual } from '@skelm/core'
import type { Pipeline, Run, RunStatus, RunStore, RunSummary } from '@skelm/core'
import type { Runner } from '@skelm/core'
import type { RunEvent } from '@skelm/core'
import type { H3Event } from 'h3'
import type { H3Error } from 'h3'
import {
  createApp,
  createError,
  createRouter,
  eventHandler,
  readBody,
  send,
  setResponseHeader,
  setResponseStatus,
  toNodeListener,
} from 'h3'
import type { AuthMode, ServerConfig } from './config.js'
import { validateServerConfig } from './config.js'
import { mountControlRoutes } from './control-routes.js'
import type { AsyncStartResponse, PipelineInfo, SkelmServer, SyncRunResponse } from './types.js'

/**
 * In-memory idempotency store: maps (pipelineId, key) -> runId
 */
const idempotencyStore = new Map<string, string>()

function makeIdempotencyKey(pipelineId: string, key: string): string {
  return `${pipelineId}:${key}`
}

/**
 * Create a skelm HTTP server
 */
export function createServer(
  config: ServerConfig,
  options: {
    pipelines: Pipeline[]
    runStore: RunStore
    runner: Runner
    /** When supplied, mounts the gateway control surface (auth-gated). */
    gateway?: import('../lifecycle/gateway.js').Gateway
  },
): SkelmServer {
  validateServerConfig(config)

  const { pipelines, runStore, runner } = options
  const { auth, token, maxConcurrentRuns = 10 } = config
  const host = config.host ?? '127.0.0.1'
  const port = config.port ?? 3000

  let server: ReturnType<typeof import('node:http').createServer> | null = null
  let isRunningFlag = false

  // h3's default error serialization drops the `message` field, leaving
  // clients with `{statusCode, statusMessage, stack: [], data}` and no
  // useful body. This handler adds `name` and `message` while keeping
  // the existing top-level fields, so callers reading either shape work.
  const app = createApp({
    onError: async (error: H3Error, event) => {
      if (event.handled) return
      const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500
      const body: Record<string, unknown> = {
        statusCode,
        statusMessage: error.statusMessage,
        name: error.name && error.name !== 'Error' ? error.name : 'H3Error',
        message: error.message || error.statusMessage || 'Internal Server Error',
      }
      if (error.data !== undefined) body.data = error.data
      // Stack frames are gated behind an explicit opt-in. Ad-hoc and
      // --foreground gateways run with NODE_ENV unset, so a NODE_ENV gate
      // would leak absolute server paths to every HTTP client. Operators
      // who want stacks set SKELM_DEBUG_HTTP_ERRORS=1; default OFF for
      // every gateway flavor (supervised, ad-hoc, foreground).
      if (process.env.SKELM_DEBUG_HTTP_ERRORS === '1' && typeof error.stack === 'string') {
        body.stack = error.stack
      }
      setResponseStatus(event, statusCode, error.statusMessage)
      setResponseHeader(event, 'Content-Type', 'application/json')
      await send(event, JSON.stringify(body))
    },
  })

  // Middleware: opt-in dev CORS (default-OFF, preserving default-deny). Only
  // when SKELM_DEV_CORS is set does the gateway emit CORS headers, so a static
  // browser chat page (the chatui `web` transport) can POST a line and tail
  // `/runs/:id/stream` cross-origin. `1`/`true` reflects the request Origin; any
  // other value is used as the explicit allowed origin. Mounted before auth so
  // the credential-less preflight (OPTIONS) is answered, not rejected.
  const devCors = process.env.SKELM_DEV_CORS
  const devCorsOrigin =
    devCors === undefined || devCors === '' || devCors === '0' || devCors === 'false'
      ? undefined
      : devCors
  if (devCorsOrigin !== undefined) {
    const reflectOrigin = devCorsOrigin === '1' || devCorsOrigin === 'true'
    app.use(
      eventHandler((event: H3Event) => {
        // No Origin header → not a CORS request; emit nothing (don't advertise a
        // CORS policy on same-origin/non-browser requests).
        const origin = event.headers.get('origin')
        if (origin === null) return undefined
        setResponseHeader(
          event,
          'Access-Control-Allow-Origin',
          reflectOrigin ? origin : devCorsOrigin,
        )
        // Vary only matters when the value depends on the request Origin.
        if (reflectOrigin) setResponseHeader(event, 'Vary', 'Origin')
        setResponseHeader(event, 'Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        setResponseHeader(event, 'Access-Control-Allow-Headers', 'authorization, content-type')
        if ((event.node.req.method ?? 'GET').toUpperCase() === 'OPTIONS') {
          event.node.res.statusCode = 204
          return ''
        }
        return undefined
      }),
    )
  }

  // Middleware: Auth
  app.use(
    eventHandler(async (event: H3Event) => {
      if (auth === 'none') {
        return
      }

      const authHeader = event.headers.get('authorization')
      const providedToken = token ?? process.env.SKELM_TOKEN

      if (!providedToken) {
        throw createError({
          statusCode: 500,
          message: 'Server token not configured',
        })
      }

      if (
        !authHeader?.startsWith('Bearer ') ||
        !timingSafeStringEqual(authHeader.slice(7), providedToken)
      ) {
        throw createError({
          statusCode: 401,
          message: 'Unauthorized',
        })
      }
    }),
  )

  // Mount the gateway control surface BEFORE the existing /runs and
  // /pipelines routes so the more-specific control paths
  // (/runs/:runId/approve, /runs/:runId/deny) win over the catch-all
  // prefix-match handlers below.
  if (options.gateway !== undefined) {
    mountControlRoutes(app, options.gateway)
  }

  // GET /pipelines - list all pipelines
  app.use(
    '/pipelines',
    eventHandler(async (_event: H3Event) => {
      const pipelineList: PipelineInfo[] = pipelines.map((p) => ({
        id: p.id,
        description: p.description ?? '',
        version: p.version ?? '',
      }))

      return pipelineList
    }),
  )

  // POST /pipelines/:id/run - sync execution
  app.use(
    '/pipelines/:id/run',
    eventHandler(async (event: H3Event) => {
      const pipelineId = event.context.params?.id
      if (!pipelineId) {
        throw createError({ statusCode: 400, message: 'Pipeline ID required' })
      }

      const pipeline = pipelines.find((p) => p.id === pipelineId)
      if (!pipeline) {
        throw createError({ statusCode: 404, message: 'Pipeline not found' })
      }

      const body = await readBody(event).catch(() => ({}))
      const input = (body as Record<string, unknown>)?.input ?? {}

      // Check idempotency key
      const idempotencyKey = event.headers.get('idempotency-key')
      let runId: string
      if (idempotencyKey) {
        const storeKey = makeIdempotencyKey(pipelineId, idempotencyKey)
        const existingRunId = idempotencyStore.get(storeKey)
        if (existingRunId) {
          // Return existing run result
          const state = await runStore.getRun(existingRunId)
          if (state) {
            return getSyncResponse(state)
          }
        }
        runId = existingRunId ?? crypto.randomUUID()
      } else {
        runId = crypto.randomUUID()
      }

      // Start the run
      const handle = runner.start(pipeline, input as never, {
        runId,
        ...(pipeline.baseDir !== undefined && { workflowPath: pipeline.baseDir }),
      })

      // Wait for completion (with timeout)
      const state = await waitForCompletion(runStore, handle.runId, 300000) // 5 min timeout

      // Store idempotency key
      if (idempotencyKey) {
        const storeKey = makeIdempotencyKey(pipelineId, idempotencyKey)
        idempotencyStore.set(storeKey, handle.runId)
      }

      return getSyncResponse(state)
    }),
  )

  // POST /pipelines/:id/start - async execution
  app.use(
    '/pipelines/:id/start',
    eventHandler(async (event: H3Event) => {
      const pipelineId = event.context.params?.id
      if (!pipelineId) {
        throw createError({ statusCode: 400, message: 'Pipeline ID required' })
      }

      const pipeline = pipelines.find((p) => p.id === pipelineId)
      if (!pipeline) {
        throw createError({ statusCode: 404, message: 'Pipeline not found' })
      }

      // Check idempotency key
      const idempotencyKey = event.headers.get('idempotency-key')
      let runId: string
      if (idempotencyKey) {
        const storeKey = makeIdempotencyKey(pipelineId, idempotencyKey)
        const existingRunId = idempotencyStore.get(storeKey)
        if (existingRunId) {
          return { runId: existingRunId, status: 'running' as const }
        }
        runId = existingRunId ?? crypto.randomUUID()
      } else {
        runId = crypto.randomUUID()
      }

      const body = await readBody(event).catch(() => ({}))
      const input = (body as Record<string, unknown>)?.input ?? {}

      const handle = runner.start(pipeline, input as never, {
        runId,
        ...(pipeline.baseDir !== undefined && { workflowPath: pipeline.baseDir }),
      })

      // Store idempotency key
      if (idempotencyKey) {
        const storeKey = makeIdempotencyKey(pipelineId, idempotencyKey)
        idempotencyStore.set(storeKey, handle.runId)
      }

      return { runId: handle.runId, status: 'running' as const }
    }),
  )

  // Runs router — uses createRouter() for proper method+path matching
  // (app.use() does prefix matching which causes /runs/:id to be caught by /runs)
  const runsRouter = createRouter()

  runsRouter.get(
    '/runs',
    eventHandler(async (event: H3Event) => {
      const url = event.node.req.url ?? ''
      const params = new URLSearchParams(url.includes('?') ? url.split('?', 2)[1] : '')
      const pipelineId = params.get('pipelineId') ?? undefined
      const statusParam = (params.get('status') as RunStatus | null) ?? undefined
      const triggerId = params.get('triggerId') ?? undefined
      // Clamp user-supplied limit so a single GET can't materialise the
      // entire run history into JSON (heap blow + event-loop stall on
      // stringify). Default 50, hard cap 1000.
      const rawLimit = Number.parseInt(params.get('limit') ?? '50')
      const limit = Number.isNaN(rawLimit) ? 50 : Math.max(1, Math.min(1000, rawLimit))

      const filter: {
        pipelineId?: string
        status?: RunStatus
        triggerId?: string
        limit?: number
      } = { limit }
      if (pipelineId !== undefined) filter.pipelineId = pipelineId
      if (statusParam !== undefined) filter.status = statusParam
      if (triggerId !== undefined) filter.triggerId = triggerId

      const runs: RunSummary[] = []
      for await (const run of runStore.listRuns(filter)) {
        runs.push(run)
      }

      return runs.map((r) => ({
        runId: r.runId,
        pipelineId: r.pipelineId,
        ...(r.workflowPath !== undefined && { workflowPath: r.workflowPath }),
        ...(r.triggerId !== undefined && { triggerId: r.triggerId }),
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
      }))
    }),
  )

  runsRouter.get(
    '/runs/:runId',
    eventHandler(async (event: H3Event) => {
      const runId = event.context.params?.runId
      if (!runId) throw createError({ statusCode: 400, message: 'Run ID required' })
      const state = await runStore.getRun(runId)
      if (!state) throw createError({ statusCode: 404, message: 'Run not found' })
      return state
    }),
  )

  runsRouter.get(
    '/runs/:runId/stream',
    eventHandler(async (event: H3Event) => {
      const runId = event.context.params?.runId
      if (!runId) throw createError({ statusCode: 400, message: 'Run ID required' })
      const state = await runStore.getRun(runId)
      if (!state) throw createError({ statusCode: 404, message: 'Run not found' })

      // Prefer the gateway-wide events bus (every per-request Runner publishes
      // to it). The legacy `runner` arg is the in-process Runner the bare
      // createServer() path used; embedded callers that boot via the Gateway
      // class pass `runner: undefined` and rely on gateway.events.
      const bus = runner !== undefined ? runner.events : options.gateway?.events
      if (bus === undefined) {
        throw createError({
          statusCode: 500,
          message: 'no event bus available for SSE; missing runner or gateway',
        })
      }

      // Raw SSE response. Bypassing h3's EventStream gives us an explicit
      // `res.flushHeaders()` and avoids the TransformStream buffering that
      // delayed initial chunk delivery on sub-second runs. See the comment
      // in packages/cli/src/run.ts:96-105 for the prior diagnosis.
      const res = event.node.res
      const req = event.node.req
      event._handled = true
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'private, no-cache, no-store, no-transform, must-revalidate, max-age=0',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.flushHeaders()

      const writeFrame = (eventType: string, data: string): void => {
        if (res.writableEnded || res.destroyed) return
        res.write(`event: ${eventType}\ndata: ${data}\n\n`)
      }

      // Buffer live events that arrive while we're draining the persisted
      // history, then merge them after replay with composite-key dedup.
      // Dedup key: type|at|stepId|delta|attempt (high-entropy fields per-run).
      //
      // TODO(sse-dedup): two identical `step.partial` tokens emitted in
      // the same wall-clock millisecond for the same stepId share a key
      // and the second is silently dropped during the (narrow) replay-tail
      // merge window. A fast-streaming LLM on a local gateway can emit
      // dozens of tokens per ms. The right long-term fix is a stable
      // sequence number on RunEvent (sqlite rowid or runner-assigned
      // monotonic counter) so the key is unambiguous; for now the race
      // is short-lived and limited to repeated tokens.
      const tailBuffer: RunEvent[] = []
      const seen = new Set<string>()
      const keyOf = (e: RunEvent): string => {
        const stepId = 'stepId' in e ? (e.stepId ?? '') : ''
        const delta = 'delta' in e ? String(e.delta) : ''
        const attempt = 'attempt' in e ? String(e.attempt) : ''
        return `${e.type}|${e.at}|${stepId}|${delta}|${attempt}`
      }

      const isTerminal = (e: RunEvent): boolean =>
        e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled'

      let isClosed = false
      let unsubscribe: () => void = () => {}
      let heartbeat: ReturnType<typeof setInterval> | undefined
      const finishPromise = new Promise<void>((resolve) => {
        const close = (): void => {
          if (isClosed) return
          isClosed = true
          unsubscribe()
          if (heartbeat !== undefined) clearInterval(heartbeat)
          if (!res.writableEnded) {
            try {
              res.end()
            } catch {
              // socket already gone
            }
          }
          resolve()
        }
        // Buffer phase: collect, don't push.
        unsubscribe = bus.forRun(runId, (runEvent: RunEvent) => {
          tailBuffer.push(runEvent)
        })
        req.on('close', close)
        req.on('error', close)

        // Initial run.state snapshot lets clients render before any events
        // arrive. Not part of the persisted event stream.
        writeFrame(
          'run.state',
          JSON.stringify({
            runId: state.runId,
            pipelineId: state.pipelineId,
            status: state.status,
            steps: state.steps,
            startedAt: state.startedAt,
            completedAt: state.completedAt,
            output: state.output,
            error: state.error,
            ...(state.waiting !== undefined && { waiting: state.waiting }),
          }),
        )

        // Replay-then-tail. Eliminates the "subscribed too late" race for
        // sub-second runs: persisted events drain first, then live events
        // that weren't already in the replay flush from the buffer.
        ;(async () => {
          try {
            for await (const e of runStore.listEvents(runId)) {
              if (isClosed) return
              const k = keyOf(e)
              seen.add(k)
              writeFrame(e.type, JSON.stringify(e))
              if (isTerminal(e)) {
                close()
                return
              }
            }
            // Switch buffered tail into push mode. Drain anything queued
            // during the replay above (skipping events we already sent),
            // then swap the subscriber to write directly.
            const queued = tailBuffer.splice(0)
            for (const e of queued) {
              if (isClosed) return
              const k = keyOf(e)
              if (seen.has(k)) continue
              seen.add(k)
              writeFrame(e.type, JSON.stringify(e))
              if (isTerminal(e)) {
                close()
                return
              }
            }
            unsubscribe()
            unsubscribe = bus.forRun(runId, (runEvent: RunEvent) => {
              if (isClosed) return
              const k = keyOf(runEvent)
              if (seen.has(k)) return
              seen.add(k)
              writeFrame(runEvent.type, JSON.stringify(runEvent))
              if (isTerminal(runEvent)) close()
            })
            // If the run completed during replay/drain the snapshot already
            // reflected a terminal status — close on that as well.
            if (
              state.status === 'completed' ||
              state.status === 'failed' ||
              state.status === 'cancelled'
            ) {
              close()
              return
            }
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err)
            writeFrame('error', JSON.stringify({ message: detail }))
            close()
          }
        })()

        // 15s heartbeat keeps NAT/proxy timeouts at bay and surfaces dead
        // peers via a failed write so we can release the subscription
        // instead of leaking it on a half-open TCP socket.
        heartbeat = setInterval(() => {
          if (isClosed) return
          try {
            res.write('event: ping\ndata: {}\n\n')
          } catch {
            close()
          }
        }, 15_000)
        heartbeat.unref?.()
      })

      return finishPromise
    }),
  )

  runsRouter.post(
    '/runs/:runId/resume',
    eventHandler(async (event: H3Event) => {
      const runId = event.context.params?.runId
      if (!runId) throw createError({ statusCode: 400, message: 'Run ID required' })
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object' ? (rawBody as { output?: unknown }) : {}
      const output = Object.hasOwn(body, 'output') ? body.output : {}
      try {
        await runner.resume(runId, output)
        return { success: true }
      } catch (err) {
        throw createError({ statusCode: 400, message: (err as Error).message })
      }
    }),
  )

  app.use(runsRouter)

  async function getSyncResponse(state: Run): Promise<SyncRunResponse> {
    if (state.status === 'completed') {
      return {
        runId: state.runId,
        status: 'completed',
        output: state.output ?? undefined,
      }
    }

    if (state.status === 'failed') {
      const error: { message: string; code?: string } = {
        message: state.error?.message ?? 'Unknown error',
      }
      if (state.error?.name) error.code = state.error.name
      return {
        runId: state.runId,
        status: 'failed',
        error,
      }
    }

    if (state.status === 'waiting') {
      const waitStep = state.steps.find((s) => s.status === 'waiting')
      const result: SyncRunResponse = {
        runId: state.runId,
        status: 'waiting',
      }
      if (waitStep) {
        result.wait = {
          stepId: waitStep.id,
          message: 'Waiting for resume',
          schema: null,
        }
      }
      return result
    }

    // Still running - return current state
    return {
      runId: state.runId,
      status: 'failed',
      error: { message: 'Run did not complete within timeout', code: 'TIMEOUT' },
    }
  }

  async function waitForCompletion(
    store: RunStore,
    runId: string,
    timeoutMs: number,
  ): Promise<Run> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const state = await store.getRun(runId)
      if (!state) {
        throw createError({ statusCode: 500, message: 'Run not found' })
      }

      if (state.status === 'completed' || state.status === 'failed' || state.status === 'waiting') {
        return state
      }

      await new Promise((r) => setTimeout(r, 100))
    }

    throw createError({ statusCode: 504, message: 'Request timeout' })
  }

  return {
    async start() {
      const http = await import('node:http')
      server = http.createServer(toNodeListener(app))
      // Bound how long a client may take to send headers / the full request so
      // a slow-loris client can't hold a connection open indefinitely. These
      // govern *receiving* the request, not the response, so long-lived SSE
      // streams (GET /runs/:id/stream) are unaffected. Tighter than Node's
      // defaults (headers 60s / request 300s).
      server.headersTimeout = 20_000
      server.requestTimeout = 60_000
      // F042: an EADDRINUSE (or any other listen-time error) used to fall
      // through as an unhandled `error` event because the Promise only
      // resolved on the listening callback. That crashed the process and
      // — because the caller had already written the lockfile — left a
      // stale lockfile on disk. Reject the promise instead so the caller
      // can run its catch block.
      await new Promise<void>((resolve, reject) => {
        if (server === null) {
          reject(new Error('gateway server was disposed before start'))
          return
        }
        const onError = (err: Error) => {
          server?.off('listening', onListening)
          server = null
          isRunningFlag = false
          reject(err)
        }
        const onListening = () => {
          server?.off('error', onError)
          isRunningFlag = true
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen({ port, host })
      })
    },

    async stop() {
      if (server) {
        isRunningFlag = false
        await new Promise<void>((resolve) => {
          server?.close(() => resolve())
        })
        server = null
      }
    },

    isRunning() {
      return isRunningFlag
    },

    getUrl() {
      return `http://${host}:${port}`
    },
  }
}
