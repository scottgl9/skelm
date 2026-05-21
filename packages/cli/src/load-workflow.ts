import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Pipeline } from '@skelm/core'
import { loadTsModule, pickExport } from '@skelm/core'

/**
 * Load a workflow module by file path. The module's default export must be
 * a `Pipeline` value produced by `pipeline()` from @skelm/core. The
 * pipeline file's directory is recorded on the returned value as
 * `baseDir` so steps that declare relative paths (e.g.
 * `code({ module: './step.ts' })`) resolve consistently.
 */
export async function loadWorkflowFromFile(filePath: string): Promise<Pipeline> {
  const absolute = resolve(process.cwd(), filePath)
  if (!existsSync(absolute)) {
    throw new CliError(`workflow file not found: ${absolute}`, 'workflow-not-found')
  }
  const url = pathToFileURL(absolute).href
  const mod = await loadTsModule(url)
  const defaultExport = pickExport(mod, 'default')
  const candidate =
    (isPipelineValue(defaultExport) ? defaultExport : undefined) ?? mod.workflow ?? mod.pipeline
  if (!isPipelineValue(candidate)) {
    throw new CliError(
      `workflow file does not export a pipeline (default export): ${absolute}`,
      'workflow-invalid',
    )
  }
  return Object.freeze({ ...candidate, baseDir: dirname(absolute) })
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
