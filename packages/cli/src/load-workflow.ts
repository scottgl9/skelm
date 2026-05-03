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
  const candidate = mod.default ?? mod.workflow ?? mod.pipeline
  if (!isPipelineValue(candidate)) {
    throw new CliError(
      `workflow file does not export a pipeline (default export): ${absolute}`,
      'workflow-invalid',
    )
  }
  return candidate
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
