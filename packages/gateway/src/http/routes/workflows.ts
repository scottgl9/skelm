import { describePipeline } from '@skelm/core'
import { type Router, createError, eventHandler, readBody } from 'h3'
import type { Gateway } from '../../lifecycle/gateway.js'
import {
  WorkflowRegistrationError,
  WorkflowRegistrationService,
} from '../../workflows/workflow-registration-service.js'
import { decodeMaybe, loadPipelineFromPath, tryToJsonSchema } from './utils.js'

interface RegisterBody {
  id?: unknown
  source?: { type?: unknown; path?: unknown } | unknown
  description?: unknown
  version?: unknown
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
export function registerWorkflowRoutes(router: Router, gateway: Gateway): void {
  const service = gateway.getWorkflowRegistrationService()

  router.get(
    '/v1/workflows',
    eventHandler(async () =>
      service.list().map((entry) => ({ id: entry.id, file: entry.path })),
    ),
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
      const body = (await readBody(event).catch(() => ({}))) as RegisterBody
      const id = takeId(service, body.id)
      const path = extractSourcePath(body.source)
      const description = takeOptionalString(body.description, 'description')
      const version = takeOptionalString(body.version, 'version')
      const loader = requireLoader(gateway)
      const real = await resolveOrThrow(service, path)
      await loadPipelineFromPath(loader, id, real)
      const record = await service.upsert({
        id,
        sourcePath: real,
        ...(description !== undefined && { description }),
        ...(version !== undefined && { version }),
      })
      return { registered: true, workflow: record }
    }),
  )

  router.put(
    '/v1/workflows/:id',
    eventHandler(async (event) => {
      const id = takeId(service, decodeMaybe(event.context.params?.id))
      const body = (await readBody(event).catch(() => ({}))) as RegisterBody
      const path = extractSourcePath(body.source)
      const description = takeOptionalString(body.description, 'description')
      const version = takeOptionalString(body.version, 'version')
      const loader = requireLoader(gateway)
      const real = await resolveOrThrow(service, path)
      await loadPipelineFromPath(loader, id, real)
      const record = await service.upsert({
        id,
        sourcePath: real,
        ...(description !== undefined && { description }),
        ...(version !== undefined && { version }),
      })
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
      const removed = await service.remove(id)
      if (!removed) {
        throw createError({ statusCode: 404, message: 'workflow not registered' })
      }
      return { unregistered: true, id }
    }),
  )
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
  gateway: Gateway,
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
