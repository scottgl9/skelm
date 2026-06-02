import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_CONFIG, type SkelmConfig, pickExport } from '@skelm/core'
import { parse as parseDotEnv } from 'dotenv'

export interface ResolvedConfig {
  /** The merged config (DEFAULT_CONFIG + user config + overrides). */
  config: SkelmConfig
  /** Absolute path to the config file that was loaded, or null if defaults only. */
  source: string | null
  /** Project root the config was discovered from. */
  projectRoot: string
  /** True when the loaded user config explicitly declared default permissions. */
  hasExplicitDefaultPermissions: boolean
  /** True when the loaded user config explicitly declared permission profiles. */
  hasExplicitPermissionProfiles: boolean
}

/**
 * Locate and load a skelm.config.mts (or .ts/.js/.mjs) by walking up from `fromDir`.
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
    const projectRoot = dirname(absolute)
    return {
      config: applyEnvLayers(mergeWithDefaults(config), projectRoot),
      source: absolute,
      projectRoot,
      hasExplicitDefaultPermissions: config.defaults?.permissions !== undefined,
      hasExplicitPermissionProfiles: config.defaults?.permissionProfiles !== undefined,
    }
  }

  const found = walkUpForConfig(opts?.fromDir ?? process.cwd())
  if (found === null) {
    const projectRoot = opts?.fromDir ?? process.cwd()
    // No user config: surface DEFAULT_CONFIG but DROP its framework deny-all
    // permission baseline. Otherwise that baseline lands on the gateway via
    // `new Gateway({ config })` (which only strips in its own no-config
    // fallback, not when `options.config` is supplied) and becomes the
    // operator ceiling — every step's resolved policy is intersected with
    // deny, so a workflow that explicitly grants `networkEgress: 'allow'`
    // still routes to a backend that throws PermissionDeniedError. Mirrors
    // the same intent as the Gateway constructor's no-config branch and
    // matches the loader's documented contract: framework permission
    // defaults are non-authoritative.
    return {
      config: applyEnvLayers(withoutFrameworkPermissionDefaults(DEFAULT_CONFIG), projectRoot),
      source: null,
      projectRoot,
      hasExplicitDefaultPermissions: false,
      hasExplicitPermissionProfiles: false,
    }
  }
  const config = await importConfigModule(found)
  const projectRoot = dirname(found)
  return {
    config: applyEnvLayers(mergeWithDefaults(config), projectRoot),
    source: found,
    projectRoot,
    hasExplicitDefaultPermissions: config.defaults?.permissions !== undefined,
    hasExplicitPermissionProfiles: config.defaults?.permissionProfiles !== undefined,
  }
}

/**
 * Merge a `.env` file at `projectRoot` and `config.env` into `process.env`
 * with precedence `process.env > .env > config.env`. The returned config has
 * its `env` field replaced with the fully-merged view so callers can inspect
 * exactly what was applied. Values already present in `process.env` are never
 * overwritten — running with `FOO=x skelm run` keeps the explicit override.
 *
 * Exported for tests.
 */
export function applyEnvLayers(config: SkelmConfig, projectRoot: string): SkelmConfig {
  const dotEnvPath = join(projectRoot, '.env')
  const dotEnv: Record<string, string> = existsSync(dotEnvPath)
    ? (parseDotEnv(readFileSync(dotEnvPath)) as Record<string, string>)
    : {}

  const merged: Record<string, string> = {
    ...(config.env ?? {}),
    ...dotEnv,
  }

  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }

  return { ...config, env: Object.freeze({ ...merged }) }
}

function withoutFrameworkPermissionDefaults(config: SkelmConfig): SkelmConfig {
  if (config.defaults?.permissions === undefined) return config
  const { permissions: _drop, ...restDefaults } = config.defaults
  return { ...config, defaults: restDefaults }
}

const CONFIG_FILENAMES = [
  'skelm.config.mts',
  'skelm.config.ts',
  'skelm.config.js',
  'skelm.config.mjs',
]

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
  const mod = (await import(url)) as Record<string, unknown>
  // pickExport handles the require(esm) `{ default: { default: <value> } }`
  // shape Node 22+ produces under CJS interop.
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
