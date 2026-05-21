import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_CONFIG, type SkelmConfig, pickExport } from '@skelm/core'
import { tsImport } from 'tsx/esm/api'

export interface ResolvedConfig {
  /** The merged config (DEFAULT_CONFIG + user config + overrides). */
  config: SkelmConfig
  /** Absolute path to the config file that was loaded, or null if defaults only. */
  source: string | null
  /** Project root the config was discovered from. */
  projectRoot: string
}

/**
 * Locate and load a skelm.config.ts (or .js) by walking up from `fromDir`.
 * Falls back to DEFAULT_CONFIG when nothing is found.
 */
export async function loadSkelmConfig(opts?: {
  fromDir?: string
  explicitPath?: string
}): Promise<ResolvedConfig> {
  if (opts?.explicitPath !== undefined) {
    const absolute = resolve(opts.fromDir ?? process.cwd(), opts.explicitPath)
    if (!existsSync(absolute)) {
      throw new Error(`config file not found: ${absolute}`)
    }
    const config = await importConfigModule(absolute)
    return { config: mergeWithDefaults(config), source: absolute, projectRoot: dirname(absolute) }
  }

  const found = walkUpForConfig(opts?.fromDir ?? process.cwd())
  if (found === null) {
    return { config: DEFAULT_CONFIG, source: null, projectRoot: opts?.fromDir ?? process.cwd() }
  }
  const config = await importConfigModule(found)
  return { config: mergeWithDefaults(config), source: found, projectRoot: dirname(found) }
}

const CONFIG_FILENAMES = ['skelm.config.ts', 'skelm.config.js', 'skelm.config.mjs']

function walkUpForConfig(start: string): string | null {
  let dir = resolve(start)
  // Stop at filesystem root.
  while (true) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function importConfigModule(absolutePath: string): Promise<SkelmConfig> {
  const url = pathToFileURL(absolutePath).href
  const mod = (await tsImport(url, import.meta.url)) as Record<string, unknown>
  // pickExport handles the require(esm) `{ default: { default: <value> } }`
  // shape Node 22+ produces under tsx's CJS loader path.
  const candidate = pickExport(mod, 'default') ?? mod.config
  if (candidate === undefined || candidate === null || typeof candidate !== 'object') {
    throw new Error(`config file must export a default config object: ${absolutePath}`)
  }
  return candidate as SkelmConfig
}

function mergeWithDefaults(user: SkelmConfig): SkelmConfig {
  // Shallow merge for the v0.1 surface; deeper merging lands as soon as
  // sub-keys grow. We deliberately do NOT merge user permission defaults
  // with framework defaults — the user's choice is authoritative for
  // security; we only fill in unspecified top-level sections.
  const merged: SkelmConfig = {
    ...DEFAULT_CONFIG,
    ...user,
    backends: { ...DEFAULT_CONFIG.backends, ...user.backends },
    pipelines: { ...DEFAULT_CONFIG.pipelines, ...user.pipelines },
    secrets: { ...DEFAULT_CONFIG.secrets, ...user.secrets },
  }
  const defaults = user.defaults ?? DEFAULT_CONFIG.defaults
  if (defaults !== undefined) {
    merged.defaults = {
      ...(DEFAULT_CONFIG.defaults !== undefined ? { ...DEFAULT_CONFIG.defaults } : {}),
      ...(user.defaults !== undefined ? { ...user.defaults } : {}),
      ...(DEFAULT_CONFIG.defaults?.permissionProfiles !== undefined ||
      user.defaults?.permissionProfiles !== undefined
        ? {
            permissionProfiles: {
              ...DEFAULT_CONFIG.defaults?.permissionProfiles,
              ...user.defaults?.permissionProfiles,
            },
          }
        : {}),
      ...(user.defaults?.permissions !== undefined && { permissions: user.defaults.permissions }),
    }
  }
  const userServer = user.server ?? {}
  const defaultServer = DEFAULT_CONFIG.server ?? {}
  const mergedServer = { ...defaultServer, ...userServer }
  const mergedAuth = userServer.auth ?? defaultServer.auth
  if (mergedAuth !== undefined) {
    mergedServer.auth = mergedAuth
  }
  merged.server = mergedServer
  const defaultStorage = DEFAULT_CONFIG.storage ?? {}
  const userStorage = user.storage ?? {}
  merged.storage = {
    ...defaultStorage,
    ...userStorage,
    runs: { ...defaultStorage.runs, ...userStorage.runs },
    state: { ...defaultStorage.state, ...userStorage.state },
    workspaces: { ...defaultStorage.workspaces, ...userStorage.workspaces },
  }
  return merged
}
