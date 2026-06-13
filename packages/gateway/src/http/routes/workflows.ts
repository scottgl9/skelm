import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import {
  type GraphEdit,
  type RunStatus,
  type RunSummary,
  applyGraphEdits,
  deriveWorkflowGraph,
  describePipeline,
} from '@skelm/core'
import {
  type H3Event,
  type MultiPartData,
  type Router,
  createError,
  eventHandler,
  getHeader,
  getQuery,
  readBody,
  readMultipartFormData,
} from 'h3'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'
import { materializePathWorkflow } from '../../workflows/path-materialization.js'
import type { WorkflowArchiveService } from '../../workflows/workflow-archive-service.js'
import type { MaterializedWorkflowArtifact } from '../../workflows/workflow-artifact-service.js'
import {
  type RegisteredWorkflowRecord,
  WorkflowRegistrationError,
  type WorkflowRegistrationService,
} from '../../workflows/workflow-registration-service.js'
import {
  decodeMaybe,
  loadPipelineFromPath,
  loadWorkflowForGraph,
  tryToJsonSchema,
} from './utils.js'

interface RegisterBody {
  id?: unknown
  source?: { type?: unknown; path?: unknown } | unknown
  description?: unknown
  version?: unknown
  steps?: unknown
}

interface ValidateBody {
  source?: { type?: unknown; path?: unknown } | unknown
}

/**
 * Mount POST /v1/workflows/validate, POST /v1/workflows/register, PUT/DELETE
 * /v1/workflows/:id, and GET /v1/workflows. The auth middleware on the
 * parent server applies to all routes; the registration service enforces
 * path safety on every accepted source.
 *
 * The service is shared with the trigger dispatcher boot path via
 * gateway.getWorkflowRegistrationService(), so dispatched runs see
 * registered workflows just like glob-discovered ones.
 */
export function registerWorkflowRoutes(router: Router, gateway: GatewayContext): void {
  const service = gateway.getWorkflowRegistrationService()

  router.get(
    '/v1/workflows/health',
    eventHandler(async (event) => {
      const recentFailuresLimit = parseRecentFailuresLimit(getQuery(event).recentFailuresLimit)
      return {
        generatedAt: new Date().toISOString(),
        gateway: workflowGatewayReadiness(gateway),
        workflows: await workflowHealthList(gateway, service, recentFailuresLimit),
      }
    }),
  )

  router.get(
    '/v1/workflows/:id/health',
    eventHandler(async (event) => {
      const id = decodeMaybe(event.context.params?.id)
      if (id === undefined || id.length === 0) {
        throw createError({ statusCode: 400, message: 'workflow id is required' })
      }
      const recentFailuresLimit = parseRecentFailuresLimit(getQuery(event).recentFailuresLimit)
      const entry = gateway.registries.workflows.get(id)
      if (entry === undefined) {
        throw createError({ statusCode: 404, message: 'workflow not found' })
      }
      const registered = new Set(service.list().map((e) => e.id))
      // Load once and share between run collection and health reporting.
      const preloaded = await loadWorkflowModule(gateway, entry)
      const runs = await collectWorkflowRuns(gateway, entry, preloaded?.pipelineId)
      return {
        generatedAt: new Date().toISOString(),
        gateway: workflowGatewayReadiness(gateway),
        workflow: await workflowHealth(
          gateway,
          entry,
          registered,
          runs,
          recentFailuresLimit,
          preloaded,
        ),
      }
    }),
  )

  router.get(
    '/v1/workflows/:id/graph',
    eventHandler(async (event) => {
      const id = decodeMaybe(event.context.params?.id)
      if (id === undefined || id.length === 0) {
        throw createError({ statusCode: 400, message: 'workflow id is required' })
      }
      const loader = gateway.getWorkflowLoader()
      if (loader === undefined) {
        throw createError({ statusCode: 501, message: 'gateway has no workflow loader' })
      }
      const { entry, workflow: preloaded } = await resolveWorkflowEntry(
        gateway,
        service,
        loader,
        id,
      )
      if (entry === undefined) {
        throw createError({ statusCode: 404, message: 'workflow not found' })
      }
      const workflow = preloaded ?? (await loadWorkflowForGraph(loader, entry.id, entry.path))
      return deriveWorkflowGraph(workflow)
    }),
  )

  router.post(
    '/v1/workflows/:id/source/apply',
    eventHandler(async (event) => {
      const id = decodeMaybe(event.context.params?.id)
      if (id === undefined || id.length === 0) {
        throw createError({ statusCode: 400, message: 'workflow id is required' })
      }
      const body = (await readBody(event).catch(() => ({}))) as {
        edits?: unknown
        dryRun?: unknown
      }
      if (!Array.isArray(body.edits) || body.edits.length === 0) {
        throw createError({ statusCode: 400, message: 'edits must be a non-empty array' })
      }
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
        throw createError({ statusCode: 400, message: 'dryRun must be a boolean' })
      }
      // Default-safe: a request that does not explicitly set dryRun: false
      // never writes.
      const dryRun = body.dryRun !== false
      const loader = requireLoader(gateway)
      const { entry } = await resolveWorkflowEntry(gateway, service, loader, id)
      if (entry === undefined) {
        throw createError({ statusCode: 404, message: 'workflow not found' })
      }
      // The EXECUTABLE source is what gets edited: the gateway-owned managed
      // copy for managed/archive registrations, the authored host file for
      // legacy 'path' records and glob-discovered workflows (no record).
      const record = await service.getRecord(entry.id)
      const executablePath = record?.sourcePath ?? entry.path
      // Path safety, defense in depth: the executable source must still
      // resolve (realpath, so symlink swaps cannot escape) inside the allowed
      // registration roots before we read or write anything.
      let real: string
      try {
        real = await service.resolveSourcePath(executablePath)
      } catch (err) {
        if (err instanceof WorkflowRegistrationError) {
          await gateway.enforcement.auditWriter.write({
            actor: 'gateway',
            action: 'workflow.source.apply',
            details: {
              workflowId: entry.id,
              denied: true,
              reason: 'source path is outside the allowed roots',
            },
          })
          throw createError({
            statusCode: 400,
            message: 'workflow source path is outside the allowed roots',
          })
        }
        throw err
      }
      const source = await readFile(real, 'utf8')
      const result = applyGraphEdits(source, body.edits as GraphEdit[])
      if (!result.ok) {
        throw createError({
          statusCode: 422,
          message: `${result.reason}: ${result.detail}`,
          data: { reason: result.reason, detail: result.detail },
        })
      }
      // Validate the generated source by loading it through the gateway's own
      // loader BEFORE any write. The probe lives in the same directory so
      // relative imports resolve identically.
      const probe = join(
        dirname(real),
        `.skelm-apply-${randomBytes(8).toString('hex')}${extname(real)}`,
      )
      await writeFile(probe, result.source, 'utf8')
      let probeConsumed = false
      try {
        try {
          await loadWorkflowForGraph(loader, `apply:${entry.id}:${probe}`, probe)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw createError({
            statusCode: 422,
            message: `generated source failed validation: ${message}`,
          })
        }
        if (dryRun) {
          return { ok: true, applied: false, dryRun: true, diff: result.diff }
        }
        if (
          record !== undefined &&
          (record.sourceKind === 'managed' || record.sourceKind === 'archive')
        ) {
          // Drop the probe before re-materializing so it is not copied into
          // the new revision tree.
          await unlink(probe).catch(() => {})
          probeConsumed = true
          const revision = await applyToManagedCopy(gateway, service, record, real, result.source)
          await gateway.enforcement.auditWriter.write({
            actor: 'gateway',
            action: 'workflow.source.apply',
            details: {
              workflowId: entry.id,
              sourceKind: record.sourceKind,
              editCount: body.edits.length,
              revision,
            },
          })
          return { ok: true, applied: true, diff: result.diff, revision }
        }
        // 'path' kind: the authored host file is the source-controlled truth;
        // replace it atomically (the probe doubles as the temp file).
        await rename(probe, real)
        probeConsumed = true
        await gateway.enforcement.auditWriter.write({
          actor: 'gateway',
          action: 'workflow.source.apply',
          details: {
            workflowId: entry.id,
            sourceKind: 'path',
            editCount: body.edits.length,
          },
        })
        return { ok: true, applied: true, diff: result.diff }
      } finally {
        if (!probeConsumed) await unlink(probe).catch(() => {})
      }
    }),
  )

  router.get(
    '/v1/workflows',
    eventHandler(async () => {
      // Merge glob-discovered workflows with explicitly-registered ones so
      // the listing endpoint surfaces the same set the runner can actually
      // dispatch. `WorkflowRegistry.list()` already produces the union
      // (registered entries shadow glob hits with the same id). Tag each
      // entry by source so dashboards can differentiate.
      const registered = new Set(service.list().map((e) => e.id))
      return gateway.registries.workflows.list().map((entry) => ({
        id: entry.id,
        file: entry.path,
        source: registered.has(entry.id) ? ('registered' as const) : ('glob' as const),
      }))
    }),
  )

  router.post(
    '/v1/workflows/validate',
    eventHandler(async (event) => {
      const body = (await readBody(event).catch(() => ({}))) as ValidateBody
      const path = extractSourcePath(body.source)
      const loader = requireLoader(gateway)
      const real = await resolveOrThrow(service, path)
      // Use the candidate id 'validate:<path>' so the loader has a stable
      // registryId for caching; nothing is persisted.
      const pipeline = await loadPipelineFromPath(loader, `validate:${real}`, real)
      const desc = describePipeline(pipeline)
      const [inputSchema, outputSchema] = await Promise.all([
        tryToJsonSchema((pipeline as { inputSchema?: unknown }).inputSchema),
        tryToJsonSchema((pipeline as { outputSchema?: unknown }).outputSchema),
      ])
      return {
        valid: true,
        pipeline: {
          id: desc.id,
          ...(desc.description !== undefined && { description: desc.description }),
          ...(desc.version !== undefined && { version: desc.version }),
          graph: { steps: desc.steps },
          input: inputSchema,
          output: outputSchema,
        },
      }
    }),
  )

  router.post(
    '/v1/workflows/register',
    eventHandler(async (event) => {
      if (isMultipart(event)) {
        const archive = gateway.getWorkflowArchiveService()
        return await registerFromArchive(event, gateway, service, archive, 'register')
      }
      const body = (await readBody(event).catch(() => ({}))) as RegisterBody
      const id = takeId(service, body.id)
      const existing = await service.getRecord(id)
      const description = takeOptionalString(body.description, 'description')
      const version = takeOptionalString(body.version, 'version')
      const loader = requireLoader(gateway)
      const record =
        body.source === undefined
          ? await (async () => {
              const real = await materializeInlineJsonWorkflow(gateway, id, body, 'register')
              await loadPipelineFromPath(loader, id, real)
              return service.upsert({
                id,
                sourcePath: real,
                sourceKind: 'archive',
                ...(description !== undefined && { description }),
                ...(version !== undefined && { version }),
              })
            })()
          : await (async () => {
              const materialized = await materializePathWorkflow(gateway, {
                id,
                path: extractSourcePath(body.source),
                registrationService: service,
              })
              await loadPipelineFromPath(loader, id, materialized.entryPath)
              return service.upsert({
                id,
                sourcePath: materialized.entryPath,
                sourceKind: 'managed',
                originPath: materialized.originPath,
                originKind: 'path',
                ...(description !== undefined && { description }),
                ...(version !== undefined && { version }),
              })
            })()
      if (existing?.sourceKind === 'archive' && body.source !== undefined) {
        await gateway.getWorkflowArchiveService().remove(id)
      }
      return { registered: true, workflow: record }
    }),
  )

  router.put(
    '/v1/workflows/:id',
    eventHandler(async (event) => {
      const id = takeId(service, decodeMaybe(event.context.params?.id))
      const existing = await service.getRecord(id)
      if (isMultipart(event)) {
        const archive = gateway.getWorkflowArchiveService()
        const result = await registerFromArchive(event, gateway, service, archive, 'replace', id)
        if (existing?.sourceKind === 'managed') {
          await gateway.getWorkflowArtifactService().remove(id)
        }
        return result
      }
      const body = (await readBody(event).catch(() => ({}))) as RegisterBody
      const path = extractSourcePath(body.source)
      const description = takeOptionalString(body.description, 'description')
      const version = takeOptionalString(body.version, 'version')
      const loader = requireLoader(gateway)
      const materialized = await materializePathWorkflow(gateway, {
        id,
        path,
        registrationService: service,
      })
      await loadPipelineFromPath(loader, id, materialized.entryPath)
      const record = await service.upsert({
        id,
        sourcePath: materialized.entryPath,
        sourceKind: 'managed',
        originPath: materialized.originPath,
        originKind: 'path',
        ...(description !== undefined && { description }),
        ...(version !== undefined && { version }),
      })
      if (existing?.sourceKind === 'archive') {
        await gateway.getWorkflowArchiveService().remove(id)
      }
      return { updated: true, workflow: record }
    }),
  )

  router.delete(
    '/v1/workflows/:id',
    eventHandler(async (event) => {
      const id = decodeMaybe(event.context.params?.id)
      if (id === undefined || id.length === 0) {
        throw createError({ statusCode: 400, message: 'id is required' })
      }
      const existing = await service.getRecord(id)
      const removed = await service.remove(id)
      if (!removed) {
        throw createError({ statusCode: 404, message: 'workflow not registered' })
      }
      if (existing?.sourceKind === 'archive' || existing?.sourceKind === 'managed') {
        // A source-apply on an archive-origin workflow cuts managed revisions
        // while retaining the extraction dir for in-flight runs, so a record
        // of either kind may hold data in both gateway-owned stores.
        await gateway.getWorkflowArchiveService().remove(id)
        await gateway.getWorkflowArtifactService().remove(id)
      }
      // A workflow can be both explicitly registered AND surfaced by the FS
      // glob; unregistering only drops the explicit entry, so the glob copy
      // can survive. Surface that so callers don't assume the id is gone.
      const survivor = gateway.registries.workflows.get(id)
      return {
        unregistered: true,
        id,
        ...(survivor !== undefined && {
          stillDiscoveredByGlob: true,
          file: survivor.path,
        }),
      }
    }),
  )
}

/**
 * Resolve by registry id first; fall back to scanning for a workflow whose
 * declared id matches — mirrors GET /pipelines/:id so callers can pass either
 * the registry id or the authored workflow id. Shared by the graph and
 * source-apply routes so both resolve a workflow identically.
 */
async function resolveWorkflowEntry(
  gateway: GatewayContext,
  service: WorkflowRegistrationService,
  loader: (registryId: string, absolutePath: string) => Promise<unknown>,
  id: string,
): Promise<{
  entry: { id: string; path: string } | undefined
  workflow?: Awaited<ReturnType<typeof loadWorkflowForGraph>>
}> {
  const direct = gateway.registries.workflows.get(id)
  if (direct !== undefined) return { entry: direct }
  for (const candidate of gateway.registries.workflows.list()) {
    try {
      const real = await service.resolveSourcePath(candidate.path)
      const workflow = await loadWorkflowForGraph(loader, candidate.id, real)
      if (workflow.id === id) return { entry: candidate, workflow }
    } catch {
      // skip workflows that fail to load
    }
  }
  return { entry: undefined }
}

/**
 * Cut a NEW managed revision whose entry file carries the edited source, then
 * repoint the registration record (and through it the registry) at the new
 * revision entry. Old revisions are deliberately retained so in-flight runs
 * keep resolving their tree. Returns the new revision segment.
 */
async function applyToManagedCopy(
  gateway: GatewayContext,
  service: WorkflowRegistrationService,
  record: RegisteredWorkflowRecord,
  realEntry: string,
  editedSource: string,
): Promise<string> {
  const treeRoot = await managedSourceTreeRoot(gateway, record, realEntry)
  let artifact: MaterializedWorkflowArtifact
  try {
    artifact = await gateway.getWorkflowArtifactService().materializeTree({
      id: record.id,
      sourceRoot: treeRoot,
      entryPath: realEntry,
      ...(record.originPath !== undefined && { originPath: record.originPath }),
    })
  } catch (err) {
    if (err instanceof WorkflowRegistrationError) {
      throw createError({ statusCode: err.statusCode, message: err.message })
    }
    throw err
  }
  try {
    const tmp = join(
      dirname(artifact.entryPath),
      `.skelm-apply-${randomBytes(8).toString('hex')}${extname(artifact.entryPath)}`,
    )
    await writeFile(tmp, editedSource, 'utf8')
    await rename(tmp, artifact.entryPath)
    await service.upsert({
      id: record.id,
      sourcePath: artifact.entryPath,
      sourceKind: 'managed',
      ...(record.originPath !== undefined && { originPath: record.originPath }),
      ...(record.originKind !== undefined && { originKind: record.originKind }),
      ...(record.description !== undefined && { description: record.description }),
      ...(record.version !== undefined && { version: record.version }),
    })
  } catch (err) {
    // Nothing references the new revision until upsert succeeds, so a failure
    // here can drop it without affecting any run.
    await rm(artifact.artifactDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  return basename(artifact.artifactDir)
}

/**
 * Locate the root of the gateway-owned tree holding the record's executable
 * source: the revision dir under the artifact root for managed copies, the
 * extraction dir for archive uploads. A record whose executable path does not
 * sit inside its own kind's store is corrupted — refuse rather than guess.
 */
async function managedSourceTreeRoot(
  gateway: GatewayContext,
  record: RegisteredWorkflowRecord,
  realEntry: string,
): Promise<string> {
  if (record.sourceKind === 'archive') {
    const root = await realpathOr(gateway.getWorkflowArchiveService().destinationFor(record.id))
    if (relative(root, realEntry).startsWith('..')) {
      throw createError({
        statusCode: 500,
        message: 'workflow record is inconsistent with its archive storage',
      })
    }
    return root
  }
  const artifactRoot = await realpathOr(gateway.getWorkflowArtifactService().artifactRoot)
  const [idSegment, revisionSegment] = relative(artifactRoot, realEntry).split(sep)
  if (
    idSegment === undefined ||
    idSegment === '..' ||
    revisionSegment === undefined ||
    realEntry === join(artifactRoot, idSegment, revisionSegment)
  ) {
    throw createError({
      statusCode: 500,
      message: 'workflow record is inconsistent with its managed storage',
    })
  }
  return join(artifactRoot, idSegment, revisionSegment)
}

async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

interface WorkflowLoadData {
  pipelineId?: string | undefined
  description?: string | undefined
  version?: string | undefined
  loadable: boolean
  loadError?: string | undefined
}

async function loadWorkflowModule(
  gateway: GatewayContext,
  entry: { id: string; path: string },
): Promise<WorkflowLoadData | null> {
  const loader = gateway.getWorkflowLoader()
  if (loader === undefined) return null
  try {
    const pipeline = await loadPipelineFromPath(loader, entry.id, entry.path)
    const desc = describePipeline(pipeline)
    return {
      pipelineId: desc.id,
      description: desc.description,
      version: desc.version,
      loadable: true,
    }
  } catch (err) {
    return {
      loadable: false,
      loadError: err instanceof Error ? err.message : String(err),
    }
  }
}

type WorkflowReadinessStatus = 'ready' | 'degraded' | 'broken'

interface WorkflowHealthRunFailure {
  runId: string
  pipelineId: string
  message: string
  at: number
}

interface WorkflowHealthRunRef {
  runId: string
  pipelineId: string
  status: RunStatus
  startedAt: number
  triggerId?: string
}

interface WorkflowHealth {
  id: string
  file: string
  source: 'registered' | 'glob'
  pipelineId?: string
  description?: string
  version?: string
  readiness: {
    status: WorkflowReadinessStatus
    ready: boolean
    checks: {
      gateway: boolean
      registered: boolean
      loadable: boolean | null
      hasRecentFailures: boolean
      hasTriggerErrors: boolean
    }
    reason?: string
  }
  runs: {
    total: number
    active: number
    byStatus: Record<RunStatus, number>
    recentFailures: WorkflowHealthRunFailure[]
    truncated: boolean
  }
  activeRuns: WorkflowHealthRunRef[]
  triggers: Array<{
    id: string
    kind: string
    overlap: string
    fired: number
    inflight: boolean
    queueDepth: number
    runningCount: number
    lastFiredAt: string | null
    lastError: string | null
  }>
}

const RUN_STATUSES: readonly RunStatus[] = [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]

const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['pending', 'running', 'waiting'])
const HEALTH_RUN_SCAN_LIMIT = 5_000

async function workflowHealthList(
  gateway: GatewayContext,
  service: WorkflowRegistrationService,
  recentFailuresLimit: number,
): Promise<WorkflowHealth[]> {
  const registered = new Set(service.list().map((e) => e.id))
  const runs = await collectRunWindow(
    gateway.runStore.listRuns({ limit: HEALTH_RUN_SCAN_LIMIT + 1 }),
  )
  return await Promise.all(
    gateway.registries.workflows
      .list()
      .map((entry) => workflowHealth(gateway, entry, registered, runs, recentFailuresLimit)),
  )
}

async function workflowHealth(
  gateway: GatewayContext,
  entry: { id: string; path: string },
  registered: ReadonlySet<string>,
  allRuns: RunWindow,
  recentFailuresLimit: number,
  preloaded?: WorkflowLoadData | null,
): Promise<WorkflowHealth> {
  let pipelineId: string | undefined
  let description: string | undefined
  let version: string | undefined
  let loadable: boolean | null = null
  let loadError: string | undefined

  if (preloaded !== undefined && preloaded !== null) {
    pipelineId = preloaded.pipelineId
    description = preloaded.description
    version = preloaded.version
    loadable = preloaded.loadable
    loadError = preloaded.loadError
  } else if (preloaded === undefined) {
    const loader = gateway.getWorkflowLoader()
    if (loader !== undefined) {
      try {
        const pipeline = await loadPipelineFromPath(loader, entry.id, entry.path)
        const desc = describePipeline(pipeline)
        pipelineId = desc.id
        description = desc.description
        version = desc.version
        loadable = true
      } catch (err) {
        loadable = false
        loadError = err instanceof Error ? err.message : String(err)
      }
    }
  }

  const workflowRuns = allRuns.runs.filter((run) => runBelongsToWorkflow(run, entry, pipelineId))
  const byStatus = countRunsByStatus(workflowRuns)
  const activeRuns = workflowRuns
    .filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
    .map((run) => ({
      runId: run.runId,
      pipelineId: run.pipelineId,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.triggerId !== undefined && { triggerId: run.triggerId }),
    }))
  const triggers = gateway.managers.triggers
    .list()
    .filter((reg) => reg.spec.workflowId === entry.id || reg.spec.workflowId === pipelineId)
    .map((reg) => ({
      id: reg.spec.id,
      kind: reg.spec.kind,
      overlap: reg.overlap,
      fired: reg.fired,
      inflight: reg.inflight,
      queueDepth: gateway.managers.triggers.queueDepth(reg.spec.id),
      runningCount: gateway.managers.triggers.runningCount(reg.spec.id),
      lastFiredAt: reg.lastFiredAt ?? null,
      lastError: reg.lastError ?? null,
    }))
  const recentFailures = await recentWorkflowFailures(
    gateway,
    workflowRuns.filter((run) => run.status === 'failed'),
    recentFailuresLimit,
  )
  const hasTriggerErrors = triggers.some((trigger) => trigger.lastError !== null)
  const readiness = workflowReadiness({
    gatewayReady: gateway.getState() === 'running',
    registered: gateway.registries.workflows.get(entry.id) !== undefined,
    loadable,
    hasRecentFailures: recentFailures.length > 0,
    hasTriggerErrors,
    ...(loadError !== undefined && { loadError }),
  })

  return {
    id: entry.id,
    file: entry.path,
    source: registered.has(entry.id) ? 'registered' : 'glob',
    ...(pipelineId !== undefined && { pipelineId }),
    ...(description !== undefined && { description }),
    ...(version !== undefined && { version }),
    readiness,
    runs: {
      total: workflowRuns.length,
      active: activeRuns.length,
      byStatus,
      recentFailures,
      truncated: allRuns.truncated,
    },
    activeRuns,
    triggers,
  }
}

function workflowGatewayReadiness(gateway: GatewayContext): { state: string; ready: boolean } {
  const state = gateway.getState()
  return { state, ready: state === 'running' }
}

function workflowReadiness(opts: {
  gatewayReady: boolean
  registered: boolean
  loadable: boolean | null
  hasRecentFailures: boolean
  hasTriggerErrors: boolean
  loadError?: string
}): WorkflowHealth['readiness'] {
  const ready =
    opts.gatewayReady &&
    opts.registered &&
    opts.loadable === true &&
    !opts.hasRecentFailures &&
    !opts.hasTriggerErrors
  let status: WorkflowReadinessStatus = ready ? 'ready' : 'degraded'
  let reason: string | undefined
  if (!opts.gatewayReady) reason = 'gateway is not running'
  else if (!opts.registered) reason = 'workflow is not registered'
  else if (opts.loadable === false) {
    status = 'broken'
    reason = opts.loadError ?? 'workflow failed to load'
  } else if (opts.loadable === null) reason = 'workflow loadability is unchecked'
  else if (opts.hasTriggerErrors) reason = 'one or more triggers have errors'
  else if (opts.hasRecentFailures) reason = 'one or more recent runs failed'
  return {
    status,
    ready,
    checks: {
      gateway: opts.gatewayReady,
      registered: opts.registered,
      loadable: opts.loadable,
      hasRecentFailures: opts.hasRecentFailures,
      hasTriggerErrors: opts.hasTriggerErrors,
    },
    ...(reason !== undefined && { reason }),
  }
}

function runBelongsToWorkflow(
  run: RunSummary,
  entry: { id: string; path: string },
  pipelineId: string | undefined,
): boolean {
  return (
    run.pipelineId === entry.id || run.pipelineId === pipelineId || run.workflowPath === entry.path
  )
}

async function recentWorkflowFailures(
  gateway: GatewayContext,
  runs: readonly RunSummary[],
  limit: number,
): Promise<WorkflowHealthRunFailure[]> {
  return await Promise.all(
    [...runs]
      .sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt))
      .slice(0, limit)
      .map(async (run) => {
        const full = await gateway.runStore.getRun(run.runId)
        return {
          runId: run.runId,
          pipelineId: run.pipelineId,
          message: full?.error?.message ?? firstStepErrorMessage(full?.steps) ?? 'unknown error',
          at: run.completedAt ?? run.startedAt,
        }
      }),
  )
}

function firstStepErrorMessage(
  steps: readonly { error?: { message?: string } }[] | undefined,
): string | undefined {
  return steps?.find((step) => step.error?.message !== undefined)?.error?.message
}

interface RunWindow {
  runs: RunSummary[]
  truncated: boolean
}

async function collectWorkflowRuns(
  gateway: GatewayContext,
  entry: { id: string; path: string },
  pipelineIdHint?: string,
): Promise<RunWindow> {
  let pipelineId = pipelineIdHint
  if (pipelineId === undefined) {
    const loader = gateway.getWorkflowLoader()
    if (loader !== undefined) {
      try {
        pipelineId = describePipeline(await loadPipelineFromPath(loader, entry.id, entry.path)).id
      } catch {
        // Loader threw; fall back to a full scan filtered by the known entry
        // identity. truncated reflects whether the scan may have missed runs
        // for this workflow due to the overall run window being full.
        const full = await collectRunWindow(
          gateway.runStore.listRuns({ limit: HEALTH_RUN_SCAN_LIMIT + 1 }),
        )
        return {
          runs: full.runs.filter((run) => runBelongsToWorkflow(run, entry, undefined)),
          truncated: full.truncated,
        }
      }
    }
  }
  const filters = new Set([entry.id, ...(pipelineId !== undefined ? [pipelineId] : [])])
  const windows = await Promise.all(
    [...filters].map((id) =>
      collectRunWindow(
        gateway.runStore.listRuns({ pipelineId: id, limit: HEALTH_RUN_SCAN_LIMIT + 1 }),
      ),
    ),
  )
  const byRunId = new Map<string, RunSummary>()
  for (const window of windows) {
    for (const run of window.runs) byRunId.set(run.runId, run)
  }
  return {
    runs: [...byRunId.values()],
    truncated: windows.some((window) => window.truncated),
  }
}

async function collectRunWindow(iter: AsyncIterable<RunSummary>): Promise<RunWindow> {
  const out: RunSummary[] = []
  for await (const run of iter) out.push(run)
  return {
    runs: out.slice(0, HEALTH_RUN_SCAN_LIMIT),
    truncated: out.length > HEALTH_RUN_SCAN_LIMIT,
  }
}

function countRunsByStatus(runs: readonly RunSummary[]): Record<RunStatus, number> {
  const out = Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as Record<
    RunStatus,
    number
  >
  for (const run of runs) out[run.status] += 1
  return out
}

function parseRecentFailuresLimit(raw: unknown): number {
  if (raw === undefined) return 5
  if (Array.isArray(raw) || typeof raw !== 'string' || raw.length === 0) {
    throw createError({ statusCode: 400, message: 'recentFailuresLimit must be an integer' })
  }
  const limit = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100 || String(limit) !== raw) {
    throw createError({ statusCode: 400, message: 'recentFailuresLimit must be 0..100' })
  }
  return limit
}

function isMultipart(event: H3Event): boolean {
  const ctype = getHeader(event, 'content-type') ?? ''
  return ctype.toLowerCase().startsWith('multipart/form-data')
}

async function registerFromArchive(
  event: H3Event,
  gateway: GatewayContext,
  service: WorkflowRegistrationService,
  archive: WorkflowArchiveService,
  mode: 'register' | 'replace',
  fixedId?: string,
): Promise<{ registered?: true; updated?: true; workflow: unknown }> {
  const parts = (await readMultipartFormData(event)) ?? []
  const fields = collectMultipartFields(parts)
  const id = takeId(
    service,
    fixedId ?? fields.string('id') ?? `uploaded-${Date.now().toString(36)}`,
  )
  const archiveBytes = fields.file('archive')
  if (archiveBytes === undefined) {
    throw createError({ statusCode: 400, message: 'archive field with .zip file is required' })
  }
  const entry = fields.string('entry')
  const description = fields.string('description')
  const version = fields.string('version')
  const loader = requireLoader(gateway)
  let extracted: Awaited<ReturnType<WorkflowArchiveService['extract']>>
  try {
    extracted = await archive.extract({
      id,
      archive: archiveBytes,
      mode,
      ...(entry !== undefined && { entry }),
    })
  } catch (err) {
    if (err instanceof WorkflowRegistrationError) {
      throw createError({ statusCode: err.statusCode, message: err.message })
    }
    throw err
  }
  const real = await resolveOrThrow(service, extracted.entryPath)
  try {
    await loadPipelineFromPath(loader, id, real)
  } catch (err) {
    await archive.remove(id).catch(() => {})
    throw err
  }
  const record = await service.upsert({
    id,
    sourcePath: real,
    sourceKind: 'archive',
    ...(description !== undefined && { description }),
    ...(version !== undefined && { version }),
  })
  return mode === 'register'
    ? { registered: true, workflow: record }
    : { updated: true, workflow: record }
}

async function materializeInlineJsonWorkflow(
  gateway: GatewayContext,
  id: string,
  body: RegisterBody,
  mode: 'register' | 'replace',
): Promise<string> {
  if (!Array.isArray(body.steps)) {
    throw createError({ statusCode: 400, message: 'source is required' })
  }
  const archive = gateway.getWorkflowArchiveService()
  const dir = archive.destinationFor(id)
  if (mode === 'register' && (await isNonEmptyDir(dir))) {
    throw createError({
      statusCode: 409,
      message: `workflow id "${id}" already has an extracted archive; use PUT to replace`,
    })
  }
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'workflow.mts')
  await writeFile(path, inlineWorkflowModule(id, body), 'utf8')
  return path
}

async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0
  } catch {
    return false
  }
}

function inlineWorkflowModule(id: string, body: RegisterBody): string {
  const steps = (body.steps as unknown[]).map((step, index) => inlineStepModule(step, index))
  const description =
    typeof body.description === 'string'
      ? `,\n  description: ${JSON.stringify(body.description)}`
      : ''
  const version =
    typeof body.version === 'string' ? `,\n  version: ${JSON.stringify(body.version)}` : ''
  return [
    "import { code, pipeline } from 'skelm'",
    '',
    'export default pipeline({',
    `  id: ${JSON.stringify(id)}${description}${version},`,
    '  steps: [',
    steps.map((s) => `    ${s}`).join(',\n'),
    '  ],',
    '})',
    '',
  ].join('\n')
}

function inlineStepModule(step: unknown, index: number): string {
  if (typeof step !== 'object' || step === null) {
    throw createError({ statusCode: 400, message: `steps[${index}] must be an object` })
  }
  const s = step as { kind?: unknown; id?: unknown; run?: unknown }
  if (s.kind !== 'code') {
    throw createError({ statusCode: 400, message: `steps[${index}].kind must be "code"` })
  }
  if (typeof s.id !== 'string' || s.id.length === 0) {
    throw createError({ statusCode: 400, message: `steps[${index}].id is required` })
  }
  if (typeof s.run !== 'string' || s.run.length === 0) {
    throw createError({ statusCode: 400, message: `steps[${index}].run is required` })
  }
  return `code({ id: ${JSON.stringify(s.id)}, run: ${s.run} })`
}

interface MultipartFields {
  string(name: string): string | undefined
  file(name: string): Uint8Array | undefined
}

function collectMultipartFields(parts: MultiPartData[]): MultipartFields {
  const text = new Map<string, string>()
  const files = new Map<string, Uint8Array>()
  for (const part of parts) {
    if (part.name === undefined) continue
    if (part.filename !== undefined) {
      files.set(part.name, new Uint8Array(part.data))
    } else {
      text.set(part.name, part.data.toString('utf8'))
    }
  }
  return {
    string: (name) => text.get(name),
    file: (name) => files.get(name),
  }
}

function extractSourcePath(source: unknown): string {
  if (typeof source !== 'object' || source === null) {
    throw createError({ statusCode: 400, message: 'source is required' })
  }
  const s = source as { type?: unknown; path?: unknown }
  if (s.type !== 'path') {
    throw createError({
      statusCode: 400,
      message: 'only source.type = "path" is supported (code-source registration is deferred)',
    })
  }
  if (typeof s.path !== 'string' || s.path.length === 0) {
    throw createError({ statusCode: 400, message: 'source.path is required' })
  }
  return s.path
}

function requireLoader(
  gateway: GatewayContext,
): (registryId: string, absolutePath: string) => Promise<unknown> {
  const loader = gateway.getWorkflowLoader()
  if (loader === undefined) {
    throw createError({
      statusCode: 501,
      message: 'gateway has no workflow loader; cannot import workflow modules',
    })
  }
  return loader
}

async function resolveOrThrow(
  service: WorkflowRegistrationService,
  candidate: string,
): Promise<string> {
  try {
    return await service.resolveSourcePath(candidate)
  } catch (err) {
    if (err instanceof WorkflowRegistrationError) {
      throw createError({ statusCode: err.statusCode, message: err.message })
    }
    throw err
  }
}

function takeId(service: WorkflowRegistrationService, raw: unknown): string {
  try {
    return service.validateId(raw)
  } catch (err) {
    if (err instanceof WorkflowRegistrationError) {
      throw createError({ statusCode: err.statusCode, message: err.message })
    }
    throw err
  }
}

function takeOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw createError({ statusCode: 400, message: `${field} must be a string` })
  }
  return value
}
