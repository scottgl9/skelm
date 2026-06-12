import { pathToFileURL } from 'node:url'
import {
  Runner,
  type SkelmConfig,
  deriveWorkflowGraph,
  describePipeline,
  pickExport,
} from '@skelm/core'
import { type Router, createError, eventHandler, readBody } from 'h3'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'
import { createSkillSource } from '../../registries/skill-source.js'
import {
  adhocPipelineId,
  decodeMaybe,
  loadPipelineFromPath,
  makeGatewayPipelineRegistry,
  tryToJsonSchema,
  validateWorkflowFile,
} from './utils.js'

// Per-(pipeline, idempotency-key) → runId map shared by /run and /start.
const idempotency = new Map<string, string>()

export function registerPipelineRoutes(router: Router, gateway: GatewayContext): void {
  router.get(
    '/pipelines',
    eventHandler(async () => {
      const loader = gateway.getWorkflowLoader()
      const entries = gateway.registries.workflows.list()
      // `id` is the registry id (file path under projectRoot, or the
      // operator-assigned id from POST /v1/workflows/register) — that's
      // the long-standing public contract. Best-effort load each entry to
      // surface the workflow's declared `pipelineId` plus description /
      // version alongside it; loader failures fall back to the bare
      // registry shape so a single broken workflow doesn't break listing.
      return Promise.all(
        entries.map(async (entry) => {
          if (loader === undefined) return { id: entry.id, file: entry.path }
          try {
            const pipeline = await loadPipelineFromPath(loader, entry.id, entry.path)
            const desc = describePipeline(pipeline)
            return {
              id: entry.id,
              pipelineId: desc.id,
              file: entry.path,
              ...(desc.description !== undefined && { description: desc.description }),
              ...(desc.version !== undefined && { version: desc.version }),
            }
          } catch {
            return { id: entry.id, file: entry.path }
          }
        }),
      )
    }),
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
      const loader = gateway.getWorkflowLoader()
      // Resolve by registry id first (file path), fall back to scanning
      // for a pipeline whose declared id matches. The latter is what
      // `skelm describe <pipeline-id>` typically passes — the user thinks
      // of their workflow by its id() not its file location.
      let entry = gateway.registries.workflows.get(id)
      let pipeline: Awaited<ReturnType<typeof loadPipelineFromPath>> | undefined
      if (entry === undefined && loader !== undefined) {
        for (const candidate of gateway.registries.workflows.list()) {
          try {
            const p = await loadPipelineFromPath(loader, candidate.id, candidate.path)
            if ((p as { id?: string }).id === id) {
              entry = candidate
              pipeline = p
              break
            }
          } catch {
            // skip broken candidates
          }
        }
      }
      if (entry === undefined) {
        throw createError({ statusCode: 404, message: 'pipeline not found' })
      }
      if (loader === undefined) {
        return { id: entry.id, file: entry.path, graph: null, input: null, output: null }
      }
      if (pipeline === undefined) pipeline = await loadPipelineFromPath(loader, id, entry.path)
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
        workflowGraph: deriveWorkflowGraph(pipeline),
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
        events: gateway.events,
        workspaceManager: gateway.workspaceManager,
        ...(gateway.backends !== undefined && { backends: gateway.backends }),
      })
      gateway.attachMetricsBus(runner.events)
      gateway.attachOtelBus(runner.events)
      const controller = new AbortController()
      const runId = crypto.randomUUID()
      gateway.registerRun(runId, controller, runner)
      try {
        const handle = runner.start(pipeline as Parameters<Runner['start']>[0], input as never, {
          runId,
          signal: controller.signal,
          workflowPath: entry.path,
          skillSource: createSkillSource({
            registry: gateway.registries.skills,
            workflowPath: entry.path,
          }),
          pipelineRegistry: makeGatewayPipelineRegistry(gateway),
          ...gateway.defaultPermissionRunOptions(pipeline.id),
          ...gateway.defaultBackendRunOptions(pipeline.id),
          ...gateway.egressRunOptions(),
          ...gateway.agentmemoryRunOptions(),
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

  /**
   * Ad-hoc file execution: load and run a workflow from an absolute path
   * the caller supplies, without requiring it to be in the registry. Used
   * by `skelm run <path>` so the CLI doesn't need a separate code path for
   * unregistered workflows. Sync variant — waits for completion.
   */
  router.post(
    '/pipelines/run-file',
    eventHandler(async (event) => {
      const loader = gateway.getWorkflowLoader()
      if (loader === undefined) {
        throw createError({ statusCode: 501, message: 'gateway has no workflow loader' })
      }
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object'
          ? (rawBody as { file?: unknown; input?: unknown })
          : {}
      const filePath = await validateWorkflowFile(body.file)
      const id = adhocPipelineId(filePath)
      const input = body.input ?? {}
      const pipeline = await loadPipelineFromPath(loader, id, filePath)
      const enforcement = gateway.enforcement
      const runner = new Runner({
        approvalGate: enforcement.approvalGate,
        secretResolver: enforcement.secretResolver,
        auditWriter: enforcement.auditWriter,
        store: gateway.runStore,
        events: gateway.events,
        workspaceManager: gateway.workspaceManager,
        ...(gateway.backends !== undefined && { backends: gateway.backends }),
      })
      gateway.attachMetricsBus(runner.events)
      gateway.attachOtelBus(runner.events)
      const controller = new AbortController()
      const runId = crypto.randomUUID()
      gateway.registerRun(runId, controller, runner)
      try {
        const handle = runner.start(pipeline as Parameters<Runner['start']>[0], input as never, {
          runId,
          signal: controller.signal,
          workflowPath: filePath,
          skillSource: createSkillSource({
            registry: gateway.registries.skills,
            workflowPath: filePath,
          }),
          pipelineRegistry: makeGatewayPipelineRegistry(gateway),
          ...gateway.defaultPermissionRunOptions(pipeline.id),
          ...gateway.defaultBackendRunOptions(pipeline.id),
          ...gateway.egressRunOptions(),
          ...gateway.agentmemoryRunOptions(),
        })
        const finalState = await handle.wait()
        return {
          runId: finalState.runId,
          pipelineId: pipeline.id,
          status: finalState.status,
          output: finalState.output,
          ...(finalState.error !== undefined && { error: finalState.error }),
        }
      } finally {
        gateway.unregisterRun(runId)
      }
    }),
  )

  /**
   * Ad-hoc file execution, async sibling of /pipelines/run-file. Returns
   * immediately with the new runId; caller subscribes via
   * GET /runs/:runId/stream to receive events.
   */
  router.post(
    '/pipelines/start-file',
    eventHandler(async (event) => {
      const loader = gateway.getWorkflowLoader()
      if (loader === undefined) {
        throw createError({ statusCode: 501, message: 'gateway has no workflow loader' })
      }
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object'
          ? (rawBody as { file?: unknown; input?: unknown; configPath?: unknown })
          : {}
      const filePath = await validateWorkflowFile(body.file)
      const id = adhocPipelineId(filePath)
      const input = body.input ?? {}

      // Load the nearest skelm.config.* from the workflow file's directory when
      // the CLI resolved one and sent its path. Apply its defaults.permissions
      // and backends on top of the gateway-wide defaults for this run only.
      const perFilePermissions: {
        defaultPermissions?: import('@skelm/core').AgentPermissions
        permissionProfiles?: Readonly<Record<string, import('@skelm/core').AgentPermissions>>
      } = {}
      const perFileBackends: { defaultAgentBackend?: string; defaultInferBackend?: string } = {}
      if (typeof body.configPath === 'string') {
        try {
          const mod = (await import(pathToFileURL(body.configPath).href)) as Record<string, unknown>
          const fc = pickExport(mod, 'default') as SkelmConfig | undefined
          if (fc !== null && typeof fc === 'object') {
            if (fc.defaults?.permissions !== undefined)
              perFilePermissions.defaultPermissions = fc.defaults.permissions
            if (fc.defaults?.permissionProfiles !== undefined)
              perFilePermissions.permissionProfiles = fc.defaults.permissionProfiles
            const agentB = fc.backends?.agent ?? fc.backends?.default ?? fc.backend
            const inferB = fc.backends?.infer ?? fc.backends?.default ?? fc.backend
            if (typeof agentB === 'string') perFileBackends.defaultAgentBackend = agentB
            if (typeof inferB === 'string') perFileBackends.defaultInferBackend = inferB
          }
        } catch {
          // Config load failure is non-fatal for an adhoc run; gateway-wide defaults apply.
        }
      }

      const pipeline = await loadPipelineFromPath(loader, id, filePath)
      const enforcement = gateway.enforcement
      const runner = new Runner({
        approvalGate: enforcement.approvalGate,
        secretResolver: enforcement.secretResolver,
        auditWriter: enforcement.auditWriter,
        store: gateway.runStore,
        events: gateway.events,
        workspaceManager: gateway.workspaceManager,
        ...(gateway.backends !== undefined && { backends: gateway.backends }),
      })
      gateway.attachMetricsBus(runner.events)
      gateway.attachOtelBus(runner.events)
      const controller = new AbortController()
      const runId = crypto.randomUUID()
      gateway.registerRun(runId, controller, runner)
      let handle: ReturnType<Runner['start']>
      try {
        handle = runner.start(pipeline as Parameters<Runner['start']>[0], input as never, {
          runId,
          signal: controller.signal,
          workflowPath: filePath,
          skillSource: createSkillSource({
            registry: gateway.registries.skills,
            workflowPath: filePath,
          }),
          pipelineRegistry: makeGatewayPipelineRegistry(gateway),
          ...gateway.defaultPermissionRunOptions(pipeline.id),
          ...gateway.defaultBackendRunOptions(pipeline.id),
          // Per-file config overrides take precedence over gateway-wide defaults
          ...perFilePermissions,
          ...perFileBackends,
          ...gateway.egressRunOptions(),
          ...gateway.agentmemoryRunOptions(),
        })
      } catch (err) {
        gateway.unregisterRun(runId)
        throw err
      }
      void handle
        .wait()
        .catch((err) => {
          console.error(`gateway: run ${runId} wait rejected:`, (err as Error)?.message ?? err)
        })
        .finally(() => gateway.unregisterRun(runId))
      return { runId, status: 'running' as const, pipelineId: pipeline.id }
    }),
  )

  /**
   * Ad-hoc describe: load a workflow file by absolute path and return the
   * same shape GET /pipelines/:id produces. Used by `skelm describe
   * <path>` without requiring the workflow to be in the registry.
   */
  router.post(
    '/pipelines/describe-file',
    eventHandler(async (event) => {
      const loader = gateway.getWorkflowLoader()
      if (loader === undefined) {
        throw createError({ statusCode: 501, message: 'gateway has no workflow loader' })
      }
      const rawBody = await readBody(event).catch(() => undefined)
      const body =
        rawBody !== null && typeof rawBody === 'object' ? (rawBody as { file?: unknown }) : {}
      const filePath = await validateWorkflowFile(body.file)
      const id = adhocPipelineId(filePath)
      const pipeline = await loadPipelineFromPath(loader, id, filePath)
      const desc = describePipeline(pipeline)
      const [inputSchema, outputSchema] = await Promise.all([
        tryToJsonSchema((pipeline as { inputSchema?: unknown }).inputSchema),
        tryToJsonSchema((pipeline as { outputSchema?: unknown }).outputSchema),
      ])
      return {
        id: desc.id,
        file: filePath,
        ...(desc.description !== undefined && { description: desc.description }),
        ...(desc.version !== undefined && { version: desc.version }),
        graph: { steps: desc.steps },
        workflowGraph: deriveWorkflowGraph(pipeline),
        input: inputSchema,
        output: outputSchema,
      }
    }),
  )
}
