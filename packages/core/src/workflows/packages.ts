import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { RegistryError, toErrorMessage } from '../errors.js'

export interface WorkflowPackageWorkflowManifest {
  readonly id: string
  readonly path: string
  readonly export?: string
  readonly name?: string
  readonly description?: string
}

export interface WorkflowPackageManifest {
  readonly id: string
  readonly name?: string
  readonly version?: string
  readonly description?: string
  readonly workflows: readonly WorkflowPackageWorkflowManifest[]
  readonly assets?: string
  readonly docs?: string
}

export interface DiscoveredWorkflowPackageWorkflow {
  readonly id: string
  readonly path: string
  readonly absolutePath: string
  readonly exportName: string
  readonly name?: string
  readonly description?: string
}

export interface DiscoveredWorkflowPackage {
  readonly id: string
  readonly packageName: string
  readonly packageVersion?: string
  readonly name: string
  readonly version?: string
  readonly description?: string
  readonly packageRoot: string
  readonly manifestPath: string
  readonly workflows: readonly DiscoveredWorkflowPackageWorkflow[]
  readonly assets?: string
  readonly assetsPath?: string
  readonly docs?: string
  readonly docsPath?: string
}

export interface DiscoverWorkflowPackagesResult {
  readonly packages: readonly DiscoveredWorkflowPackage[]
  readonly errors: readonly RegistryError[]
}

interface PackageJsonShape {
  readonly name?: unknown
  readonly version?: unknown
  readonly description?: unknown
  readonly skelm?: unknown
}

interface SkelmPackageShape {
  readonly workflowPackage?: unknown
}

export async function discoverWorkflowPackage(
  packageRoot: string,
): Promise<DiscoveredWorkflowPackage> {
  const root = resolve(packageRoot)
  const manifestPath = resolve(root, 'package.json')
  let parsed: PackageJsonShape

  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageJsonShape
  } catch (error) {
    throw new RegistryError(
      `Workflow package manifest not found or invalid at ${manifestPath}: ${toErrorMessage(error)}`,
      'workflowPackage',
    )
  }

  const manifest = readWorkflowPackageManifest(parsed, manifestPath)
  const workflows = manifest.workflows.map((workflow) =>
    normalizeWorkflow(root, manifest.id, workflow),
  )
  const workflowIds = new Set<string>()
  for (const workflow of workflows) {
    if (workflowIds.has(workflow.id)) {
      throw new RegistryError(
        `Workflow package '${manifest.id}' declares duplicate workflow id '${workflow.id}'`,
        'workflowPackage',
        workflow.id,
      )
    }
    workflowIds.add(workflow.id)
  }

  return {
    id: manifest.id,
    packageName: requireString(parsed.name, 'package.json name', manifestPath),
    ...(typeof parsed.version === 'string' && { packageVersion: parsed.version }),
    name: manifest.name ?? requireString(parsed.name, 'package.json name', manifestPath),
    ...(manifest.version !== undefined && { version: manifest.version }),
    ...(manifest.version === undefined &&
      typeof parsed.version === 'string' && { version: parsed.version }),
    ...(manifest.description !== undefined && { description: manifest.description }),
    ...(manifest.description === undefined &&
      typeof parsed.description === 'string' && { description: parsed.description }),
    packageRoot: root,
    manifestPath,
    workflows,
    ...(manifest.assets !== undefined && {
      assets: manifest.assets,
      assetsPath: resolveInsidePackage(root, manifest.assets, manifest.id, 'assets'),
    }),
    ...(manifest.docs !== undefined && {
      docs: manifest.docs,
      docsPath: resolveInsidePackage(root, manifest.docs, manifest.id, 'docs'),
    }),
  }
}

export async function discoverWorkflowPackages(
  packageRoots: readonly string[],
): Promise<DiscoverWorkflowPackagesResult> {
  const packages: DiscoveredWorkflowPackage[] = []
  const errors: RegistryError[] = []
  const packageIds = new Set<string>()

  for (const packageRoot of packageRoots) {
    try {
      const pkg = await discoverWorkflowPackage(packageRoot)
      if (packageIds.has(pkg.id)) {
        throw new RegistryError(
          `Workflow package with id '${pkg.id}' is already discovered`,
          'workflowPackage',
          pkg.id,
        )
      }
      packageIds.add(pkg.id)
      packages.push(pkg)
    } catch (error) {
      errors.push(
        error instanceof RegistryError
          ? error
          : new RegistryError(
              `Failed to discover workflow package at ${packageRoot}: ${toErrorMessage(error)}`,
              'workflowPackage',
            ),
      )
    }
  }

  return { packages, errors }
}

export function resolveWorkflowPackagePath(
  pkg: DiscoveredWorkflowPackage,
  packageRelativePath: string,
): string {
  return resolveInsidePackage(pkg.packageRoot, packageRelativePath, pkg.id, 'path')
}

function readWorkflowPackageManifest(
  parsed: PackageJsonShape,
  manifestPath: string,
): WorkflowPackageManifest {
  if (!isRecord(parsed.skelm)) {
    throw new RegistryError(
      `package.json at ${manifestPath} is missing skelm.workflowPackage`,
      'workflowPackage',
    )
  }

  const skelm = parsed.skelm as SkelmPackageShape
  if (!isRecord(skelm.workflowPackage)) {
    throw new RegistryError(
      `package.json at ${manifestPath} is missing skelm.workflowPackage`,
      'workflowPackage',
    )
  }

  const manifest = skelm.workflowPackage as Record<string, unknown>
  const workflows = manifest.workflows
  if (!Array.isArray(workflows) || workflows.length === 0) {
    throw new RegistryError(
      `Workflow package '${String(manifest.id)}' must declare at least one workflow`,
      'workflowPackage',
    )
  }

  return {
    id: requireString(manifest.id, 'skelm.workflowPackage.id', manifestPath),
    ...(typeof manifest.name === 'string' && { name: manifest.name }),
    ...(typeof manifest.version === 'string' && { version: manifest.version }),
    ...(typeof manifest.description === 'string' && { description: manifest.description }),
    workflows: workflows.map((workflow, index) =>
      readWorkflowManifest(workflow, manifestPath, index),
    ),
    ...(typeof manifest.assets === 'string' && { assets: manifest.assets }),
    ...(typeof manifest.docs === 'string' && { docs: manifest.docs }),
  }
}

function readWorkflowManifest(
  value: unknown,
  manifestPath: string,
  index: number,
): WorkflowPackageWorkflowManifest {
  if (!isRecord(value)) {
    throw new RegistryError(
      `Workflow package entry ${index} in ${manifestPath} must be an object`,
      'workflowPackage',
    )
  }

  return {
    id: requireString(value.id, `skelm.workflowPackage.workflows[${index}].id`, manifestPath),
    path: requireString(value.path, `skelm.workflowPackage.workflows[${index}].path`, manifestPath),
    ...(typeof value.export === 'string' && { export: value.export }),
    ...(typeof value.name === 'string' && { name: value.name }),
    ...(typeof value.description === 'string' && { description: value.description }),
  }
}

function normalizeWorkflow(
  root: string,
  packageId: string,
  workflow: WorkflowPackageWorkflowManifest,
): DiscoveredWorkflowPackageWorkflow {
  return {
    id: workflow.id,
    path: workflow.path,
    absolutePath: resolveInsidePackage(root, workflow.path, packageId, `workflow '${workflow.id}'`),
    exportName: workflow.export ?? 'default',
    ...(workflow.name !== undefined && { name: workflow.name }),
    ...(workflow.description !== undefined && { description: workflow.description }),
  }
}

function resolveInsidePackage(
  root: string,
  packageRelativePath: string,
  packageId: string,
  label: string,
): string {
  if (packageRelativePath.length === 0 || isAbsolute(packageRelativePath)) {
    throw new RegistryError(
      `Workflow package '${packageId}' declares invalid ${label} path '${packageRelativePath}'`,
      'workflowPackage',
      packageId,
    )
  }

  const absolute = resolve(root, packageRelativePath)
  const rel = relative(root, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new RegistryError(
      `Workflow package '${packageId}' declares ${label} outside the package root`,
      'workflowPackage',
      packageId,
    )
  }
  return absolute
}

function requireString(value: unknown, field: string, manifestPath: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RegistryError(
      `${field} in ${manifestPath} must be a non-empty string`,
      'workflowPackage',
    )
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
