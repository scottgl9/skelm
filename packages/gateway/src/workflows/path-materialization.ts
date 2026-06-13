import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CONFIG_FILENAMES,
  PACKAGE_MANIFEST_FILENAME,
  type SkelmConfig,
  pickExport,
} from '@skelm/core'
import type { GatewayContext } from '../lifecycle/gateway-types.js'
import {
  WorkflowRegistrationError,
  type WorkflowRegistrationService,
} from './workflow-registration-service.js'

export interface MaterializedPathWorkflow {
  entryPath: string
  configPath?: string
  originPath: string
}

export async function materializePathWorkflow(
  gateway: GatewayContext,
  opts: {
    id: string
    path: string
    registrationService?: WorkflowRegistrationService
    configPath?: string
    sourceRoot?: string
  },
): Promise<MaterializedPathWorkflow> {
  const entryPath =
    opts.registrationService !== undefined
      ? await opts.registrationService.resolveSourcePath(opts.path)
      : await realpath(opts.path)
  // An installed-package entry lives inside its own self-contained,
  // integrity-verified managed copy under `.skelm/packages/<name>/<version>/`.
  // That directory is the artifact — materialize from it, not the project tree
  // (whose materializer excludes `.skelm`, which would drop the entry).
  const packageRoot = await findInstalledPackageRoot(entryPath)
  const configPath =
    packageRoot !== undefined ? undefined : await resolveConfigPath(entryPath, opts.configPath)
  const sourceRoot =
    opts.sourceRoot ??
    packageRoot ??
    (configPath !== undefined && isWithinPath(entryPath, dirname(configPath))
      ? dirname(configPath)
      : dirname(entryPath))
  const copiedConfigPath =
    configPath !== undefined && isWithinPath(configPath, sourceRoot) ? configPath : undefined
  const artifact = await gateway.getWorkflowArtifactService().materializeTree({
    id: opts.id,
    sourceRoot,
    entryPath,
    originPath: entryPath,
    ...(copiedConfigPath !== undefined && { configPath: copiedConfigPath }),
  })
  return {
    entryPath: artifact.entryPath,
    ...(artifact.configPath !== undefined && { configPath: artifact.configPath }),
    originPath: entryPath,
  }
}

export async function loadManagedConfig(configPath: string): Promise<SkelmConfig> {
  const mod = (await import(pathToFileURL(configPath).href)) as Record<string, unknown>
  const config = pickExport(mod, 'default') as SkelmConfig | undefined
  if (config === null || typeof config !== 'object') {
    throw new WorkflowRegistrationError(400, `${configPath} did not default-export a config object`)
  }
  return config
}

export function projectArtifactId(projectDir: string): string {
  return `project-${createHash('sha1').update(projectDir).digest('hex').slice(0, 16)}`
}

async function resolveConfigPath(
  entryPath: string,
  explicitConfigPath: string | undefined,
): Promise<string | undefined> {
  if (explicitConfigPath !== undefined && explicitConfigPath.length > 0) {
    try {
      return await realpath(explicitConfigPath)
    } catch {
      return undefined
    }
  }
  let dir = dirname(entryPath)
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name)
      try {
        return await realpath(candidate)
      } catch {
        // continue
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * If `entryPath` lives inside an installed workflow-package version directory
 * (`.../.skelm/packages/<encoded-name>/<version>/`), return that directory.
 * The signal is an ancestor that both carries a `.skelm/packages/` path prefix
 * and holds a package manifest — exactly the {@link WorkflowPackageStore}
 * layout — so an unrelated file under some other `.skelm` dir is not matched.
 */
async function findInstalledPackageRoot(entryPath: string): Promise<string | undefined> {
  let dir = dirname(entryPath)
  for (;;) {
    if (isUnderSkelmPackages(dir) && (await hasFile(join(dir, PACKAGE_MANIFEST_FILENAME)))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function isUnderSkelmPackages(dir: string): boolean {
  const segments = dir.split(sep)
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i] === 'packages' && segments[i - 1] === '.skelm') return true
  }
  return false
}

async function hasFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function isWithinPath(target: string, root: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`
  return target === root || target.startsWith(normalizedRoot)
}
