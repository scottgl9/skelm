import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CONFIG_FILENAMES } from '@skelm/core'
import { loadSkelmConfig } from './load-config.js'
import { CliError } from './load-workflow.js'

// index.* is tried before the single-file scan so a project can keep
// several workflow files in one directory and still declare a canonical
// entry without a config file.
const INDEX_BASENAMES = [
  'index.workflow.mts',
  'index.workflow.ts',
  'index.pipeline.mts',
  'index.pipeline.ts',
]

const WORKFLOW_RE = /\.(?:workflow|pipeline)\.m?ts$/

/**
 * Resolve a `skelm run <path>` argument to a concrete workflow file path.
 *
 * A file path is returned unchanged (the gateway reports not-found if it is
 * missing). A directory is resolved to its entrypoint:
 *
 *   1. A `skelm.config.*` file living directly in the directory whose
 *      `entrypoint` field names the workflow (resolved relative to that dir).
 *   2. Otherwise an `index.workflow.{mts,ts}` / `index.pipeline.{mts,ts}`.
 *   3. Otherwise the single `*.workflow.{mts,ts}` / `*.pipeline.{mts,ts}` file
 *      in the directory, if exactly one exists.
 *
 * Throws `CliError('entrypoint-unresolved')` when a directory has neither a
 * declared entrypoint nor an unambiguous workflow file. The CLI stays a thin
 * client — resolution happens here and the resolved file path is what gets
 * sent to the gateway.
 */
export async function resolveWorkflowPath(
  workflowPath: string,
  cwd: string = process.cwd(),
): Promise<string> {
  const abs = resolve(cwd, workflowPath)
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(abs)
  } catch {
    // Non-existent path: defer the not-found error to the gateway, which
    // produces a consistent message for both files and directories.
    return abs
  }
  if (!stats.isDirectory()) return abs
  return resolveDirectoryEntrypoint(abs)
}

async function resolveDirectoryEntrypoint(dir: string): Promise<string> {
  const configFile = CONFIG_FILENAMES.map((name) => join(dir, name)).find((p) => existsSync(p))
  if (configFile !== undefined) {
    const { config } = await loadSkelmConfig({ explicitPath: configFile })
    if (typeof config.entrypoint === 'string' && config.entrypoint.length > 0) {
      const entry = resolve(dirname(configFile), config.entrypoint)
      if (!existsSync(entry)) {
        throw new CliError(
          `${configFile} declares entrypoint '${config.entrypoint}' but ${entry} does not exist`,
          'entrypoint-unresolved',
        )
      }
      return entry
    }
  }

  for (const name of INDEX_BASENAMES) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }

  const workflows = readdirSync(dir).filter((name) => WORKFLOW_RE.test(name))
  if (workflows.length === 1) return join(dir, workflows[0] as string)
  if (workflows.length === 0) {
    throw new CliError(
      `no workflow found in ${dir}: add a skelm.config entrypoint, an index.workflow.mts, or a single *.workflow.mts file`,
      'entrypoint-unresolved',
    )
  }
  throw new CliError(
    `multiple workflow files in ${dir} (${workflows.join(', ')}): declare an entrypoint in skelm.config or add an index.workflow.mts`,
    'entrypoint-unresolved',
  )
}
