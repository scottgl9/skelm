import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Pipeline } from '@skelm/core'
import { loadTsModule, pickExport } from '@skelm/core'

/**
 * Load a workflow module by file path. The module's default export must be
 * a `Pipeline` value produced by `pipeline()` from @skelm/core. The
 * pipeline file's directory is recorded on the returned value as
 * `baseDir` so steps that declare relative paths (e.g.
 * `code({ module: './step.ts' })`) resolve consistently.
 *
 * When the workflow file lives outside any `node_modules` tree (e.g. in a
 * temporary directory), this function ensures skelm packages can still be
 * resolved by creating a transient `node_modules` symlink in the workflow's
 * directory pointing at the CLI's own `node_modules`. The symlink is removed
 * after the module loads.
 */
export async function loadWorkflowFromFile(filePath: string): Promise<Pipeline> {
  const absolute = resolve(process.cwd(), filePath)
  if (!existsSync(absolute)) {
    throw new CliError(`workflow file not found: ${absolute}`, 'workflow-not-found')
  }
  const workflowDir = dirname(absolute)
  const cleanup = ensureNodeModulesResolvable(workflowDir)
  let mod: Record<string, unknown>
  try {
    const url = pathToFileURL(absolute).href
    mod = await loadTsModule(url)
  } finally {
    cleanup()
  }
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

/**
 * Ensure that importing from the workflow's directory can resolve skelm
 * packages. Node ESM resolution walks up from the importing file's
 * location — if the workflow is in an isolated directory (e.g. /tmp) with
 * no `node_modules` ancestor, imports of `skelm` / `@skelm/*` will fail.
 *
 * Strategy: if no `node_modules` exists anywhere in the ancestry of
 * `workflowDir`, create a temporary symlink `<workflowDir>/node_modules`
 * pointing at the nearest `node_modules` in the CLI's ancestry that
 * actually contains `skelm` or `@skelm/core`. Returns a cleanup function
 * that removes the symlink.
 *
 * When a `node_modules` ancestor already exists the function is a no-op
 * and returns a no-op cleanup.
 */
function ensureNodeModulesResolvable(workflowDir: string): () => void {
  // Walk up from workflowDir looking for an existing node_modules directory.
  let dir = workflowDir
  while (true) {
    if (existsSync(join(dir, 'node_modules'))) return () => {}
    const parent = dirname(dir)
    if (parent === dir) break // filesystem root
    dir = parent
  }

  // No node_modules found in the workflow's ancestry. Find the best
  // node_modules to symlink: first try walking up from process.argv[1]
  // (the running skelm binary, e.g. node_modules/.bin/skelm), then fall
  // back to this file's location. Prefer node_modules that contains the
  // 'skelm' meta-package; fall back to one with '@skelm/core'.
  const searchRoots: string[] = []
  if (typeof process.argv[1] === 'string') {
    // Use the literal argv[1] path first — the shim node_modules/.bin/skelm
    // points into the consumer's node_modules, which is exactly where 'skelm'
    // is installed. Also add the real path for cases where argv[1] is a
    // standalone symlink in e.g. ~/.local/bin (not a node_modules shim).
    const literal = dirname(process.argv[1])
    searchRoots.push(literal)
    try {
      const real = dirname(realpathSync(process.argv[1]))
      if (real !== literal) searchRoots.push(real)
    } catch {
      /* best-effort */
    }
  }
  // Also search from cwd — when the gateway is started from a project
  // directory that has its own node_modules/skelm (e.g. the self-test repo),
  // that is the correct place to link from.
  searchRoots.push(process.cwd())
  searchRoots.push(dirname(fileURLToPath(import.meta.url)))

  let bestWithSkelm: string | undefined
  let bestWithCore: string | undefined
  outer: for (const root of searchRoots) {
    let search = root
    while (true) {
      const candidate = join(search, 'node_modules')
      if (existsSync(candidate)) {
        if (bestWithCore === undefined && existsSync(join(candidate, '@skelm', 'core'))) {
          bestWithCore = candidate
        }
        if (existsSync(join(candidate, 'skelm'))) {
          bestWithSkelm = candidate
          break outer
        }
      }
      const parent = dirname(search)
      if (parent === search) break
      search = parent
    }
  }
  const cliNodeModules = bestWithSkelm ?? bestWithCore
  if (cliNodeModules === undefined) return () => {}

  const linkPath = join(workflowDir, 'node_modules')
  if (!existsSync(linkPath)) {
    try {
      mkdirSync(dirname(linkPath), { recursive: true })
      symlinkSync(cliNodeModules, linkPath)
    } catch {
      return () => {}
    }
    return () => {
      try {
        rmSync(linkPath)
      } catch {
        /* best-effort cleanup */
      }
    }
  }
  return () => {}
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
    readonly code:
      | 'workflow-not-found'
      | 'workflow-invalid'
      | 'bad-input'
      | 'argv'
      | 'internal'
      | 'wait-timeout'
      | 'wait-cancelled'
      | 'entrypoint-unresolved',
  ) {
    super(message)
  }
}
