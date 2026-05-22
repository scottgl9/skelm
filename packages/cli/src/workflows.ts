import { type Dirent, existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Pipeline } from '@skelm/core'
import { loadSkelmConfig } from './load-config.js'
import { CliError, loadWorkflowFromFile } from './load-workflow.js'

export interface DiscoveredWorkflow {
  readonly id: string
  readonly file: string
  readonly absoluteFile: string
  readonly description?: string
  readonly version?: string
  readonly pipeline: Pipeline
}

export async function discoverWorkflows(
  fromDir = process.cwd(),
): Promise<readonly DiscoveredWorkflow[]> {
  const { config, projectRoot } = await loadSkelmConfig({ fromDir })
  const files =
    config.pipelines?.discovery === 'explicit'
      ? (config.pipelines.explicit ?? []).map((file) => resolve(projectRoot, file))
      : await discoverWorkflowFiles(projectRoot, config.pipelines?.glob)

  const workflows: DiscoveredWorkflow[] = []
  for (const file of files) {
    const pipeline = await loadWorkflowFromFile(file)
    workflows.push({
      id: pipeline.id,
      file: relative(projectRoot, file) || file,
      absoluteFile: file,
      ...(pipeline.description !== undefined && { description: pipeline.description }),
      ...(pipeline.version !== undefined && { version: pipeline.version }),
      pipeline,
    })
  }

  return workflows.sort((left, right) => left.id.localeCompare(right.id))
}

export async function resolveWorkflowReference(
  reference: string,
  fromDir = process.cwd(),
): Promise<DiscoveredWorkflow> {
  const absolute = isAbsolute(reference) ? reference : resolve(fromDir, reference)
  if (existsSync(absolute)) {
    const { projectRoot } = await loadSkelmConfig({ fromDir })
    const pipeline = await loadWorkflowFromFile(absolute)
    return {
      id: pipeline.id,
      file: relative(projectRoot, absolute) || absolute,
      absoluteFile: absolute,
      ...(pipeline.description !== undefined && { description: pipeline.description }),
      ...(pipeline.version !== undefined && { version: pipeline.version }),
      pipeline,
    }
  }

  const workflows = await discoverWorkflows(fromDir)
  const match = workflows.find(
    (workflow) => workflow.id === reference || workflow.file === reference,
  )
  if (match === undefined) {
    throw new CliError(`workflow not found: ${reference}`, 'workflow-not-found')
  }
  return match
}

async function discoverWorkflowFiles(projectRoot: string, globPattern?: string): Promise<string[]> {
  const root = resolve(
    projectRoot,
    prefixBeforeWildcard(globPattern ?? 'workflows/**/*.workflow.{mts,ts}'),
  )
  const suffixes = suffixesForPattern(globPattern)
  const files: string[] = []
  await walkFiles(root, files, suffixes)
  return files.sort()
}

async function walkFiles(dir: string, out: string[], suffixes: readonly string[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(path, out, suffixes)
      continue
    }
    if (!entry.isFile()) continue
    if (suffixes.some((suffix) => path.endsWith(suffix))) {
      out.push(path)
    }
  }
}

function prefixBeforeWildcard(pattern: string): string {
  const wildcardIndex = pattern.search(/[*{?]/)
  if (wildcardIndex === -1) return '.'
  const prefix = pattern.slice(0, wildcardIndex)
  const slash = prefix.lastIndexOf('/')
  return slash === -1 ? '.' : prefix.slice(0, slash)
}

function suffixesForPattern(pattern: string | undefined): readonly string[] {
  const allSuffixes = ['.workflow.mts', '.workflow.ts', '.pipeline.mts', '.pipeline.ts']
  if (pattern === undefined) return allSuffixes
  if (pattern.includes('.workflow.')) return ['.workflow.mts', '.workflow.ts']
  if (pattern.includes('.pipeline.')) return ['.pipeline.mts', '.pipeline.ts']
  return allSuffixes
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
