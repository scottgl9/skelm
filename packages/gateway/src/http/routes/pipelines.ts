import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
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

/**
 * Validate a file path the caller wants the gateway to load. Defends the
 * gateway-as-loader trust boundary against:
 *   - relative paths (callers must give us an absolute path so we don't
 *     resolve against the gateway's cwd, which is operator-controlled)
 *   - `..` traversal in the supplied string (normalize then compare)
 *   - non-existent or non-file targets
 *   - extensions we never load (only .ts / .tsx / .mts / .cts / .js / .mjs / .cjs)
 *
 * The path validation is intentionally minimal: the gateway's existing
 * workflow loader is the actual trust boundary for "what code runs". This
 * check just stops the obvious foot-guns and the obvious cross-tenant
 * exfiltration shapes (`/etc/passwd`, `../../foo`).
 */
async function validateWorkflowFile(file: unknown): Promise<string> {
  if (typeof file !== 'string' || file === '') {
    throw createError({ statusCode: 400, message: 'file: must be a non-empty string' })
  }
  if (!isAbsolute(file)) {
    throw createError({ statusCode: 400, message: 'file: must be an absolute path' })
  }
  const normalized = normalize(file)
  if (normalized !== file || normalized.includes(`${'/'}..${'/'}`) || normalized.endsWith('/..')) {
    throw createError({ statusCode: 400, message: 'file: must not contain traversal segments' })
  }
  const ALLOWED = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/
  if (!ALLOWED.test(normalized)) {
    throw createError({
      statusCode: 400,
      message: 'file: must end in .ts, .tsx, .mts, .cts, .js, .mjs, or .cjs',
    })
  }
  try {
    const s = await stat(normalized)
    if (!s.isFile()) {
      throw createError({ statusCode: 404, message: 'file: not a regular file' })
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { statusCode?: number }
    if (e.statusCode !== undefined) throw err
    if (e.code === 'ENOENT') {
      throw createError({ statusCode: 404, message: 'file: not found' })
    }
    throw createError({ statusCode: 500, message: `file stat failed: ${e.message}` })
  }
  return normalized
}

function adhocPipelineId(file: string): string {
  // Stable id per absolute path; lets idempotency-key caching and
  // run-history lookups group repeated invocations of the same file.
  return `cli:${createHash('sha1').update(file).digest('hex').slice(0, 16)}`
}

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
            workflowPath: filePath,
          }),
          pipelineRegistry: makeGatewayPipelineRegistry(gateway),
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
      })
      gateway.attachMetricsBus(runner.events)
      const controller = new AbortController()
      const runId = crypto.randomUUID()
      gateway.registerRun(runId, controller, runner)
      let handle: ReturnType<Runner['start']>
      try {
        handle = runner.start(pipeline as Parameters<Runner['start']>[0], input as never, {
          runId,
          signal: controller.signal,
          skillSource: createSkillSource({
            registry: gateway.registries.skills,
            workflowPath: filePath,
          }),
          pipelineRegistry: makeGatewayPipelineRegistry(gateway),
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
}
