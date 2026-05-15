import { Runner, describePipeline } from '@skelm/core'
import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'
import { createSkillSource } from '../../registries/skill-source.js'
import {
  decodeMaybe,
  loadPipelineFromPath,
  makeGatewayPipelineRegistry,
  tryToJsonSchema,
} from './utils.js'

// Per-(pipeline, idempotency-key) → runId map shared by /run and /start.
const idempotency = new Map<string, string>()

export function registerPipelineRoutes(router: Router, gateway: Gateway): void {
  router.get(
    '/pipelines',
    eventHandler(async () =>
      gateway.registries.workflows.list().map((entry) => ({ id: entry.id, file: entry.path })),
    ),
  )

  router.get(
    '/pipelines/:id',
    eventHandler(async (event) => {
      const raw = event.context.params?.id
      if (!raw) throw createError({ statusCode: 400, message: 'pipeline id required' })
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
        return { id: entry.id, file: entry.path, graph: null, input: null, output: null }
      }
      const pipeline = await loadPipelineFromPath(loader, id, entry.path)
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

  router.post(
    '/pipelines/:id/run',
    eventHandler(async (event) => {
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
      const pipeline = await loadPipelineFromPath(loader, id, entry.path)
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
          skillSource: createSkillSource({
            registry: gateway.registries.skills,
            workflowPath: entry.path,
          }),
          pipelineRegistry: makeGatewayPipelineRegistry(gateway),
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
    eventHandler(async (event) => {
      const id = decodeMaybe(event.context.params?.id)
      if (!id) throw createError({ statusCode: 400, message: 'pipeline id required' })
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
      const { runId } = await gateway.startPipelineAsync(id, body.input ?? {})
      if (idemKey !== null) idempotency.set(`${id}:${idemKey}`, runId)
      return { runId, status: 'running' as const }
    }),
  )
}
