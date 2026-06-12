import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONFIG_FILENAMES, type SkelmConfig, pickExport } from '@skelm/core'
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
  const configPath = await resolveConfigPath(entryPath, opts.configPath)
  const sourceRoot =
    opts.sourceRoot ??
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

function isWithinPath(target: string, root: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`
  return target === root || target.startsWith(normalizedRoot)
}
