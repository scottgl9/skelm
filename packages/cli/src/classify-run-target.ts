import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CONFIG_FILENAMES } from '@skelm/core'
import { loadSkelmConfig } from './load-config.js'
import { resolveWorkflowPath } from './resolve-entrypoint.js'

/**
 * Structural mirror of `@skelm/integrations` ChatUiFrontend /
 * ChatUiFrontendFactory — declared locally so the CLI carries a project's
 * terminal (`tui` transport) frontend without taking a dependency on the
 * integrations package.
 */
export interface TuiFrontendLike {
  render(reply: string, payload?: unknown): void
  renderPartial?(text: string): void
  close?(): void | Promise<void>
}
export type TuiFrontendFactoryLike = (io: {
  submit: (text: string) => void
  close?: () => void
}) => TuiFrontendLike

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
    const entry = await resolveWorkflowPath(workflowPath, cwd)
    if (await staticallyExportsPersistentWorkflow(entry)) return { mode: 'activate', dir: abs }
    return { mode: 'one-shot', file: entry }
  }

  return { mode: 'one-shot', file: await resolveWorkflowPath(workflowPath, cwd) }
}

async function staticallyExportsPersistentWorkflow(entry: string): Promise<boolean> {
  let source: string
  try {
    source = await readFile(entry, 'utf8')
  } catch {
    return false
  }
  const text = stripComments(source)
  if (/export\s+default\s+persistentWorkflow\s*(?:<[^>]+>)?\s*\(/.test(text)) return true
  if (
    /export\s+default\s+\{[\s\S]*?\bkind\s*:\s*['"]persistent-workflow['"][\s\S]*?\}/.test(text)
  ) {
    return true
  }
  const persistentNames = new Set<string>()
  const declaration =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*persistentWorkflow\s*(?:<[^>]+>)?\s*\(/g
  for (let match = declaration.exec(text); match !== null; match = declaration.exec(text)) {
    if (match[1] !== undefined) persistentNames.add(match[1])
  }
  for (const name of persistentNames) {
    if (new RegExp(`export\\s+default\\s+${escapeRegExp(name)}\\b`).test(text)) return true
  }
  return false
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n\r]*/g, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
