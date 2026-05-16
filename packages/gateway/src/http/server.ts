// Public HTTP entry point. Routes that need gateway-only state (pipeline
// graph + JSON Schema serialization, durable event listing, run cancel via
// AbortController, schedule registration) are owned by control-routes.ts
// and mounted before the routes here when a gateway is supplied — see
// mountControlRoutes below. Without a gateway this surface is intentionally
// narrower; embedded callers reach those features through the gateway.

import type { Pipeline, Run, RunStatus, RunStore, RunSummary } from '@skelm/core'
import type { Runner } from '@skelm/core'
import type { RunEvent } from '@skelm/core'
import type { H3Event } from 'h3'
import {
  createApp,
  createError,
  createEventStream,
  createRouter,
  eventHandler,
  readBody,
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

  const app = createApp()

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

      if (!authHeader?.startsWith('Bearer ') || authHeader.slice(7) !== providedToken) {
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
      const handle = runner.start(pipeline, input as never, { runId })

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

      const handle = runner.start(pipeline, input as never, { runId })

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
      const limit = Number.parseInt(params.get('limit') ?? '50')

      const filter: {
        pipelineId?: string
        status?: RunStatus
        triggerId?: string
        limit?: number
      } = {}
      if (pipelineId !== undefined) filter.pipelineId = pipelineId
      if (statusParam !== undefined) filter.status = statusParam
      if (triggerId !== undefined) filter.triggerId = triggerId
      if (!Number.isNaN(limit)) filter.limit = limit

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

      const eventStream = createEventStream(event)
      const unsubscribe = runner.events.subscribe((runEvent: RunEvent) => {
        if (runEvent.runId === runId) {
          eventStream.push({ event: runEvent.type, data: JSON.stringify(runEvent) })
        }
      })
      eventStream.onClosed(() => {
        unsubscribe()
        eventStream.close()
      })
      await eventStream.push({
        event: 'run.state',
        data: JSON.stringify({
          runId: state.runId,
          pipelineId: state.pipelineId,
          status: state.status,
          steps: state.steps,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
          output: state.output,
          error: state.error,
        }),
      })
      if (
        state.status === 'completed' ||
        state.status === 'failed' ||
        state.status === 'cancelled'
      ) {
        eventStream.close()
      }
      return eventStream.send()
    }),
  )

  runsRouter.post(
    '/runs/:runId/resume',
    eventHandler(async (event: H3Event) => {
      const runId = event.context.params?.runId
      if (!runId) throw createError({ statusCode: 400, message: 'Run ID required' })
      const body = await readBody(event).catch(() => ({}))
      const output = (body as Record<string, unknown>)?.output ?? {}
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
      await new Promise<void>((resolve) => {
        server?.listen({ port, host }, () => {
          isRunningFlag = true
          resolve()
        })
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
