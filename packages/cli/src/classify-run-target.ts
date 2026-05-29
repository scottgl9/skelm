import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CONFIG_FILENAMES, isPersistentWorkflow, loadTsModule, pickExport } from '@skelm/core'
import { loadSkelmConfig } from './load-config.js'
import { resolveWorkflowPath } from './resolve-entrypoint.js'

export type RunTarget = { mode: 'one-shot'; file: string } | { mode: 'activate'; dir: string }

/**
 * Decide how `skelm run <path>` should treat its argument:
 *
 * - A file (or a non-existent path) is always a one-shot run — the gateway
 *   runs it and the CLI waits inline.
 * - A directory whose `skelm.config.*` declares `triggerSources`, or whose
 *   entrypoint is a `persistentWorkflow()`, is **activated** on the gateway:
 *   the gateway registers its trigger sources + workflow and takes ownership,
 *   and the CLI exits. Everything else is a one-shot of the resolved entrypoint.
 *
 * The common activate case is decided from the config alone (no module import).
 * Only a config-without-triggerSources directory imports the entrypoint, to
 * catch a cron/webhook-triggered persistent workflow.
 */
export async function classifyRunTarget(
  workflowPath: string,
  cwd: string = process.cwd(),
): Promise<RunTarget> {
  const abs = resolve(cwd, workflowPath)
  let isDir = false
  try {
    isDir = statSync(abs).isDirectory()
  } catch {
    // Non-existent path: one-shot; the gateway produces the not-found error.
  }
  if (!isDir) {
    return { mode: 'one-shot', file: await resolveWorkflowPath(workflowPath, cwd) }
  }

  const configFile = CONFIG_FILENAMES.map((name) => join(abs, name)).find((p) => existsSync(p))
  if (configFile !== undefined) {
    const { config } = await loadSkelmConfig({ explicitPath: configFile })
    if ((config.triggerSources?.length ?? 0) > 0) return { mode: 'activate', dir: abs }
    const entry = await resolveWorkflowPath(workflowPath, cwd)
    try {
      const mod = await loadTsModule(entry)
      if (isPersistentWorkflow(pickExport(mod, 'default'))) return { mode: 'activate', dir: abs }
    } catch {
      // Couldn't load it client-side — let the one-shot path surface the error.
    }
    return { mode: 'one-shot', file: entry }
  }

  return { mode: 'one-shot', file: await resolveWorkflowPath(workflowPath, cwd) }
}
