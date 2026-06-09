import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import type { Pipeline } from '@skelm/core'
import { createError } from 'h3'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'

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
 *
 * Shared by /pipelines/{run,start,describe}-file and POST /runs so every
 * ad-hoc-by-path entry point applies the identical guard.
 */
export async function validateWorkflowFile(file: unknown): Promise<string> {
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
      throw createError({ statusCode: 404, message: `file not found: ${normalized}` })
    }
    throw createError({ statusCode: 500, message: `file stat failed: ${e.message}` })
  }
  return normalized
}

export function adhocPipelineId(file: string): string {
  // Stable id per absolute path; lets idempotency-key caching and
  // run-history lookups group repeated invocations of the same file.
  return `cli:${createHash('sha1').update(file).digest('hex').slice(0, 16)}`
}

/**
 * Import a workflow module via the gateway's loader and validate that it
 * exports a default Pipeline. Throws h3 errors with the same status codes
 * the /pipelines/:id routes use (500 on import failure, 422 on missing/
 * invalid default export) so callers can surface them uniformly.
 *
 * Shared by /pipelines/:id, /pipelines/:id/run, /pipelines/:id/start, and
 * the /v1/workflows/* validate/register handlers — keeping the loader call
 * sites identical preserves the trust model: the gateway-owned loader is
 * the only thing that imports workflow code.
 */
export async function loadPipelineFromPath(
  loader: (registryId: string, absolutePath: string) => Promise<unknown>,
  registryId: string,
  absolutePath: string,
): Promise<Pipeline> {
  let mod: unknown
  try {
    mod = await loader(registryId, absolutePath)
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
  return pipeline
}

/**
 * Build the `pipelineRegistry` callback that `invoke()` steps use to resolve
 * a target pipeline at runtime.
 *
 * Two lookup strategies, in order:
 *   1. Direct: treat the id as a workflow-registry id (the file path
 *      relative to the project root). Fast — single load.
 *   2. Fallback: scan all registered workflows, load each via the workflow
 *      loader, and return the first whose `pipeline.id` matches. This is
 *      how `invoke({ pipelineId: 'foo' })` finds a workflow whose
 *      `pipeline({ id: 'foo' })` lives in any file under the registry glob —
 *      mirrors the in-process `pipelineRegistry` semantics that PR #84's
 *      `invoke()` unit tests use.
 *
 * Returns `undefined` if no match was found or no loader is wired.
 *
 * Centralized here so the /pipelines/:id/run handler, the /pipelines/:id/start
 * handler, and the trigger dispatcher all share a single implementation.
 */
export function makeGatewayPipelineRegistry(
  gateway: GatewayContext,
): (pipelineId: string) => Promise<Pipeline | undefined> {
  return async (pipelineId) => {
    const loader = gateway.getWorkflowLoader()
    if (loader === undefined) return undefined
    const direct = gateway.registries.workflows.get(pipelineId)
    if (direct !== undefined) {
      const mod = await loader(pipelineId, direct.path)
      const p = extractPipeline(mod)
      if (p !== undefined) return p as Pipeline
    }
    for (const entry of gateway.registries.workflows.list()) {
      const mod = await loader(entry.id, entry.path)
      const p = extractPipeline(mod) as Pipeline | undefined
      if (p?.id === pipelineId) return p
    }
    return undefined
  }
}

export function decodeMaybe(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function extractPipeline(mod: unknown): Pipeline | undefined {
  if (isPipelineish(mod)) return mod as Pipeline
  if (typeof mod === 'object' && mod !== null) {
    const m = mod as Record<string, unknown>
    if (isPipelineish(m.default)) return m.default as Pipeline
    // Node 22+'s require(esm) interop double-wraps the default export
    // when the loader follows the CJS->ESM interop path:
    // `{ default: { default: <pipeline> } }`. Accept that shape too so
    // the same workflow file works under both native ESM and require(esm).
    if (typeof m.default === 'object' && m.default !== null) {
      const inner = (m.default as Record<string, unknown>).default
      if (isPipelineish(inner)) return inner as Pipeline
    }
  }
  return undefined
}

export function isPipelineish(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return Array.isArray(v.steps) && typeof v.id === 'string'
}

/**
 * Best-effort conversion of a standard-schema-compatible schema into JSON Schema.
 * Currently understands Zod (via z.toJSONSchema, Zod 4+). Other vendors return null.
 */
export async function tryToJsonSchema(schema: unknown): Promise<unknown | null> {
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
 * Coerce a pipeline output into a string for OpenAI-shape responses.
 */
export function openaiContentFor(output: unknown): string {
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
