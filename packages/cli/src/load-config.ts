import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONFIG_FILENAMES, DEFAULT_CONFIG, type SkelmConfig, pickExport } from '@skelm/core'
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
 * Load the gateway/operator config following the lookup precedence from the
 * architecture recommendation:
 *
 *  1. Explicit path (`opts.fromPath` — from `--gateway-config` CLI flag)
 *  2. `SKELM_GATEWAY_CONFIG` environment variable
 *  3. `~/.skelm/skelm.gateway.*` (operator home config)
 *  4. Walk up from cwd: nearest `skelm.gateway.*` then `skelm.config.*`
 *     (legacy fallback for users who have not yet split their config)
 *  5. Framework defaults (`DEFAULT_CONFIG`, framework permission baseline stripped)
 *
 * When a `skelm.gateway.*` file is found (cases 1–4 above, not the legacy
 * `skelm.config.*` fallback), the loader also looks for a co-located
 * `skelm.config.*` and merges its workflow-specific fields (`instances`,
 * `triggerSources`, `registries`, `backends`, `env`, `defaults.permissions`)
 * into the returned config. This allows the gateway to register pre-built
 * backend instances and discover workflows declared in the project config
 * without requiring authors to duplicate those fields in `skelm.gateway.*`.
 *
 * For a home-dir gateway (`~/.skelm/skelm.gateway.*`) with no sibling
 * `skelm.config.*`, the loader falls back to walking up from `process.cwd()`
 * to find the nearest project config.
 */
export async function loadGatewayConfig(opts?: {
  fromPath?: string
}): Promise<ResolvedConfig> {
  // 1. Explicit path
  if (opts?.fromPath !== undefined) {
    const absolute = resolve(opts.fromPath)
    if (!existsSync(absolute)) {
      throw new Error(`gateway config file not found: ${absolute}`)
    }
    return loadGatewayFromPath(absolute)
  }

  // 2. SKELM_GATEWAY_CONFIG env var
  const envPath = process.env.SKELM_GATEWAY_CONFIG
  if (envPath !== undefined && envPath !== '') {
    const absolute = resolve(envPath)
    if (!existsSync(absolute)) {
      throw new Error(`SKELM_GATEWAY_CONFIG path not found: ${absolute}`)
    }
    return loadGatewayFromPath(absolute)
  }

  // 3. ~/.skelm/skelm.gateway.*
  const homeConfig = findHomeGatewayConfig()
  if (homeConfig !== null) {
    return loadGatewayFromPath(homeConfig)
  }

  // 4. Cwd walkup: skelm.gateway.* then skelm.config.*
  const found = walkUpForGatewayConfig(process.cwd())
  if (found !== null) {
    return loadGatewayFromPath(found)
  }

  // 5. Framework defaults (no-config path)
  const projectRoot = process.cwd()
  return {
    config: applyEnvLayers(withoutFrameworkPermissionDefaults(DEFAULT_CONFIG), projectRoot),
    source: null,
    projectRoot,
    hasExplicitDefaultPermissions: false,
    hasExplicitPermissionProfiles: false,
  }
}

/**
 * Load a gateway config from `absolute` and, when it is a `skelm.gateway.*`
 * file, also load a co-located `skelm.config.*` and merge workflow-specific
 * fields so pre-built backend `instances` and workflow registries are
 * available at gateway startup.
 */
async function loadGatewayFromPath(absolute: string): Promise<ResolvedConfig> {
  const gatewayResult = await loadFromPath(absolute)

  // Legacy path: the loaded file is skelm.config.* (pre-split fallback).
  // Don't attempt to load a second config — everything is already in the
  // one file.
  if (!isGatewayFile(absolute)) {
    return gatewayResult
  }

  // Split-config path: find and load the nearest skelm.config.* alongside
  // the gateway file, then merge workflow-specific fields.
  const workflowConfigPath = findColocatedWorkflowConfig(gatewayResult.projectRoot)
  if (workflowConfigPath === null) return gatewayResult

  const workflowResult = await loadFromPath(workflowConfigPath)
  return mergeWorkflowIntoGateway(gatewayResult, workflowResult)
}

/** Returns true when `filePath` is a `skelm.gateway.*` file (not a legacy skelm.config.*). */
function isGatewayFile(filePath: string): boolean {
  return GATEWAY_CONFIG_FILENAMES_SET.has(basename(filePath))
}

/**
 * Find a `skelm.config.*` co-located with the gateway file at `projectRoot`.
 * For home-dir gateways (`~/.skelm/`) that have no sibling project config,
 * falls back to walking up from `process.cwd()`.
 */
function findColocatedWorkflowConfig(projectRoot: string): string | null {
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(projectRoot, name)
    if (existsSync(candidate)) return candidate
  }
  // Home-dir gateway: the project config lives wherever the user ran the CLI.
  if (projectRoot === join(homedir(), '.skelm')) {
    return walkUpForConfig(process.cwd())
  }
  return null
}

/**
 * Merge workflow-specific fields from `workflow` into `gateway`, returning a
 * combined config suitable for gateway startup. Gateway (operator) fields take
 * precedence; workflow fields provide instances, backends, registries, and
 * environment variables that would otherwise be missing when the operator has
 * split their config across two files.
 *
 * Merge semantics:
 * - `instances`: additive — workflow instances not already in gateway are appended
 * - `triggerSources`: additive — same dedup-by-id rule
 * - `backends`: workflow provides base config, gateway config overrides
 * - `registries`: workflow provides base; gateway overrides individual sub-keys
 * - `pipelines`: workflow provides base; gateway overrides
 * - `defaults.backend`: workflow provides fallback if gateway has none
 * - `defaults.permissions`: gateway only — not lifted from workflow (cross-project contamination risk)
 * - `defaults.permissionProfiles`: gateway only — not lifted from workflow
 * - `defaults.unrestrictedGrants`: gateway only (operator-only security grant)
 * - `env`: workflow env applied first; gateway env wins on conflict
 * - Operator fields (server, secrets, storage, plugins, agentmemory): gateway only
 */
function mergeWorkflowIntoGateway(
  gateway: ResolvedConfig,
  workflow: ResolvedConfig,
): ResolvedConfig {
  const gc = gateway.config
  const wc = workflow.config

  // instances: additive, deduped by id (gateway wins on conflict)
  const gatewayInstanceIds = new Set((gc.instances ?? []).map((b) => b.id))
  const mergedInstances: typeof gc.instances = [
    ...(gc.instances ?? []),
    ...(wc.instances ?? []).filter((b) => !gatewayInstanceIds.has(b.id)),
  ]

  // triggerSources: additive, deduped by id (gateway wins on conflict)
  const gatewaySourceIds = new Set((gc.triggerSources ?? []).map((s) => s.id))
  const mergedTriggerSources: typeof gc.triggerSources = [
    ...(gc.triggerSources ?? []),
    ...(wc.triggerSources ?? []).filter((s) => !gatewaySourceIds.has(s.id)),
  ]

  const mergedDefaults = mergeDefaults(gc.defaults, wc.defaults)
  const mergedRegistries = mergeRegistries(gc.registries, wc.registries)

  const merged: SkelmConfig = {
    // Operator fields (server, secrets, storage, plugins, agentmemory) come
    // from gateway via this spread. Workflow fields below override the
    // DEFAULT_CONFIG values that mergeWithDefaults injected into gc.
    ...gc,
    ...(mergedInstances.length > 0 && { instances: mergedInstances }),
    ...(mergedTriggerSources.length > 0 && { triggerSources: mergedTriggerSources }),
    // backends: workflow provides the project-specific entries; gateway overrides
    backends: { ...wc.backends, ...gc.backends },
    // registries: workflow declares the workflow/skill globs and MCP servers;
    // conditional spread avoids assigning `undefined` under exactOptionalPropertyTypes
    ...(mergedRegistries !== undefined && { registries: mergedRegistries }),
    // pipelines: workflow declares discovery config
    pipelines: { ...wc.pipelines, ...gc.pipelines },
    // defaults: gateway keeps unrestrictedGrants; permissions from workflow if
    // the gateway config didn't set them; conditional spread for exactOptionalPropertyTypes
    ...(mergedDefaults !== undefined && { defaults: mergedDefaults }),
    // env: workflow env vars applied to process.env by loadFromPath above;
    // reflect the full merged view here so callers can inspect it
    env: { ...wc.env, ...gc.env },
  }

  return {
    config: merged,
    source: gateway.source,
    projectRoot: gateway.projectRoot,
    hasExplicitDefaultPermissions: gateway.hasExplicitDefaultPermissions,
    hasExplicitPermissionProfiles: gateway.hasExplicitPermissionProfiles,
  }
}

function mergeRegistries(
  gatewayReg: SkelmConfig['registries'],
  workflowReg: SkelmConfig['registries'],
): SkelmConfig['registries'] {
  if (gatewayReg === undefined && workflowReg === undefined) return undefined
  return {
    ...workflowReg,
    ...gatewayReg,
    mcpServers: [...(workflowReg?.mcpServers ?? []), ...(gatewayReg?.mcpServers ?? [])],
    agents: [...(workflowReg?.agents ?? []), ...(gatewayReg?.agents ?? [])],
  }
}

function mergeDefaults(
  gatewayDef: SkelmConfig['defaults'],
  workflowDef: SkelmConfig['defaults'],
): SkelmConfig['defaults'] {
  if (gatewayDef === undefined && workflowDef === undefined) return undefined
  return {
    // backend: workflow provides convenience fallback; gateway overrides
    ...(workflowDef?.backend !== undefined && { backend: workflowDef.backend }),
    // Gateway takes full precedence. permissions/permissionProfiles/unrestrictedGrants
    // are NOT lifted from the workflow: doing so would let one project's ceiling become
    // the gateway-global default, contaminating unrelated projects on the same gateway.
    ...gatewayDef,
  }
}

async function loadFromPath(absolute: string): Promise<ResolvedConfig> {
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

const GATEWAY_CONFIG_FILENAMES = [
  'skelm.gateway.mts',
  'skelm.gateway.ts',
  'skelm.gateway.js',
  'skelm.gateway.mjs',
]

const GATEWAY_CONFIG_FILENAMES_SET = new Set(GATEWAY_CONFIG_FILENAMES)

// Fallback names used when no skelm.gateway.* is present — covers users who
// have not yet migrated to the split config layout.
const LEGACY_GATEWAY_FALLBACK = [
  'skelm.config.mts',
  'skelm.config.ts',
  'skelm.config.js',
  'skelm.config.mjs',
]

/**
 * Walk up from `fromDir` to find the nearest `skelm.config.*`, returning its
 * absolute path or null. Does not load or execute the file.
 */
export function findSkelmConfigPath(fromDir: string): string | null {
  return walkUpForConfig(fromDir)
}

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

function walkUpForGatewayConfig(start: string): string | null {
  let dir = resolve(start)
  while (true) {
    for (const name of GATEWAY_CONFIG_FILENAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    for (const name of LEGACY_GATEWAY_FALLBACK) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function findHomeGatewayConfig(): string | null {
  const skelmDir = join(homedir(), '.skelm')
  for (const name of GATEWAY_CONFIG_FILENAMES) {
    const candidate = join(skelmDir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
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
