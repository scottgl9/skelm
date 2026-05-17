import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Pipeline } from '@skelm/core'
import { tsImport } from 'tsx/esm/api'

/**
 * Load a workflow module by file path. The module's default export must be
 * a `Pipeline` value produced by `pipeline()` from @skelm/core.
 *
 * The loader uses tsx's programmatic API so customers can author workflows
 * in TypeScript without a build step.
 */
export async function loadWorkflowFromFile(filePath: string): Promise<Pipeline> {
  const absolute = resolve(process.cwd(), filePath)
  if (!existsSync(absolute)) {
    throw new CliError(`workflow file not found: ${absolute}`, 'workflow-not-found')
  }
  const url = pathToFileURL(absolute).href
  const mod = (await tsImport(url, import.meta.url)) as Record<string, unknown>
  // Under Node's require(esm) interop (Node 22+), tsx's CJS loader returns
  // `{ default: { default: <pipeline> } }` for a user file that does
  // `export default pipeline(...)`. The native ESM loader returns
  // `{ default: <pipeline> }`. Accept both shapes so the same workflow
  // file works regardless of which loader path tsx picks.
  const defaultExport = pickDefaultExport(mod)
  const candidate = defaultExport ?? mod.workflow ?? mod.pipeline
  if (!isPipelineValue(candidate)) {
    throw new CliError(
      `workflow file does not export a pipeline (default export): ${absolute}`,
      'workflow-invalid',
    )
  }
  return candidate
}

function pickDefaultExport(mod: Record<string, unknown>): unknown {
  const direct = mod.default
  if (direct === undefined || direct === null) return direct
  if (isPipelineValue(direct)) return direct
  // Unwrap the require(esm) double-default shape.
  if (typeof direct === 'object') {
    const inner = (direct as Record<string, unknown>).default
    if (isPipelineValue(inner)) return inner
  }
  return direct
}

function isPipelineValue(v: unknown): v is Pipeline {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.id === 'string' && Array.isArray(r.steps)
}

/** A typed CLI error that carries an exit-code-friendly code string. */
export class CliError extends Error {
  override readonly name = 'CliError'
  constructor(
    message: string,
    readonly code: 'workflow-not-found' | 'workflow-invalid' | 'bad-input' | 'argv' | 'internal',
  ) {
    super(message)
  }
}
