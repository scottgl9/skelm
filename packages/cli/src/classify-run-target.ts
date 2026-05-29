import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CONFIG_FILENAMES, isPersistentWorkflow, loadTsModule, pickExport } from '@skelm/core'
import { loadSkelmConfig } from './load-config.js'
import { resolveWorkflowPath } from './resolve-entrypoint.js'

/**
 * Structural mirror of `@skelm/integrations` TuiFrontend / TuiFrontendFactory —
 * declared locally so the CLI carries a project's UI frontend without taking a
 * dependency on the integrations package.
 */
export interface TuiFrontendLike {
  render(reply: string, payload?: unknown): void
  renderPartial?(text: string): void
  close?(): void | Promise<void>
}
export type TuiFrontendFactoryLike = (io: { submit: (text: string) => void }) => TuiFrontendLike

export type RunTarget =
  | { mode: 'one-shot'; file: string }
  | { mode: 'activate'; dir: string }
  | { mode: 'tui'; dir: string; sourceId: string; frontend?: TuiFrontendFactoryLike }

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
    // A CLI-hosted TUI source (createRemoteTriggerSource) is tagged
    // `transport: 'tui'` on its live driver object. `skelm run` activates the
    // project and then hosts the terminal UI in this process.
    const tui = (config.triggerSources ?? []).find(
      (e) => (e.driver as { transport?: unknown }).transport === 'tui',
    )
    if (tui !== undefined) {
      const frontend = (tui.driver as { frontend?: TuiFrontendFactoryLike }).frontend
      return {
        mode: 'tui',
        dir: abs,
        sourceId: tui.id,
        ...(typeof frontend === 'function' && { frontend }),
      }
    }
    if ((config.triggerSources?.length ?? 0) > 0) return { mode: 'activate', dir: abs }
    // No trigger sources, but the entrypoint may still be a persistent workflow
    // driven by a cron/webhook trigger. Deciding that requires the module's
    // exported shape, so we import it here, in the CLI process.
    //
    // CAVEAT: this runs the entrypoint module's TOP-LEVEL side effects (network
    // calls, file writes, etc.) client-side, before the gateway sees anything.
    // The Telegram/TUI examples never reach here (they take the triggerSources
    // path above); a project that pairs a side-effecting entrypoint with a
    // persistentWorkflow and no triggerSources should keep those effects inside
    // the workflow body, not at module scope. (A static shape check that avoids
    // executing the module would remove this caveat but needs a parser.)
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
