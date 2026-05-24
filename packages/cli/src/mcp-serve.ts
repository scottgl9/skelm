import { resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { BackendRegistry, Pipeline } from '@skelm/core'
import { McpServer } from '@skelm/mcp-server'
import { applyConfiguredBackends, buildBackendRegistry } from './backends.js'
import { EXIT, type ExitCode } from './exit-codes.js'
import type { MainIO } from './internal/io.js'
import { loadSkelmConfig } from './load-config.js'
import { loadWorkflowFromFile } from './load-workflow.js'
import { discoverWorkflows } from './workflows.js'

export interface McpServeArgs {
  workflows: string[]
  port?: number
}

export async function mcpServeCommand(
  args: McpServeArgs,
  io: MainIO,
): Promise<{ exitCode: ExitCode }> {
  if (args.port !== undefined) {
    io.stderr.write('error: stdio only for now\n')
    return { exitCode: EXIT.CLI_ERROR }
  }

  const { config, projectRoot } = await loadSkelmConfig({ fromDir: process.cwd() })
  const workflows = await resolvePipelines(args.workflows, projectRoot, config)
  if (workflows.length === 0) {
    io.stdout.write('No workflows discovered.\n')
    return { exitCode: EXIT.OK }
  }

  const backends = await buildMergedBackendRegistry(config, workflows)
  const server = new McpServer({
    workflows: [],
    projectRoot,
    input: io.stdin as Readable,
    output: io.stdout as Writable,
    pipelines: workflows,
    ...(backends !== undefined ? { backends } : {}),
  })

  const stop = async () => {
    await server.stop()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await server.serve()
    return { exitCode: EXIT.OK }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

async function resolvePipelines(
  workflowPaths: readonly string[],
  projectRoot: string,
  config: Awaited<ReturnType<typeof loadSkelmConfig>>['config'],
): Promise<Pipeline[]> {
  if (workflowPaths.length === 0) {
    const discovered = await discoverWorkflows(projectRoot)
    return discovered.map((workflow) => applyConfiguredBackends(workflow.pipeline, config))
  }

  const loaded = await Promise.all(
    workflowPaths.map(
      async (workflowPath) => await loadWorkflowFromFile(resolve(projectRoot, workflowPath)),
    ),
  )
  return loaded.map((workflow) => applyConfiguredBackends(workflow, config))
}

async function buildMergedBackendRegistry(
  config: Awaited<ReturnType<typeof loadSkelmConfig>>['config'],
  workflows: readonly Pipeline[],
): Promise<BackendRegistry | undefined> {
  let merged: BackendRegistry | undefined

  for (const workflow of workflows) {
    const current = await buildBackendRegistry(config, workflow)
    if (current === undefined) continue
    if (merged === undefined) {
      merged = current
      continue
    }
    const known = new Set(merged.list().map((backend) => backend.id))
    for (const backend of current.list()) {
      if (!known.has(backend.id)) {
        merged.register(backend)
        known.add(backend.id)
      }
    }
  }

  return merged
}
