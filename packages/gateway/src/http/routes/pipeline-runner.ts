import { Runner } from '@skelm/core'
import { createError } from 'h3'
import type { GatewayContext } from '../../lifecycle/gateway-types.js'
import { createSkillSource } from '../../registries/skill-source.js'
import { extractPipeline, makeGatewayPipelineRegistry } from './utils.js'

/**
 * Run a registered pipeline to completion through the full gateway enforcement
 * stack. Shared by /pipelines/:id/run and the /v1/* OpenAI-compat routes.
 */
export async function runPipelineSync(
  gateway: GatewayContext,
  pipelineId: string,
  input: unknown,
): Promise<{
  runId: string
  status: string
  output: unknown
  error?: { name?: string; message?: string }
}> {
  const entry = gateway.registries.workflows.get(pipelineId)
  if (entry === undefined) {
    throw createError({ statusCode: 404, message: `pipeline not found: ${pipelineId}` })
  }
  const loader = gateway.getWorkflowLoader()
  if (loader === undefined) {
    throw createError({ statusCode: 501, message: 'gateway has no workflow loader' })
  }
  let mod: unknown
  try {
    mod = await loader(pipelineId, entry.path)
  } catch (err) {
    throw createError({
      statusCode: 500,
      message: `failed to load workflow: ${(err as Error).message}`,
    })
  }
  const pipeline = extractPipeline(mod)
  if (pipeline === undefined) {
    throw createError({
      statusCode: 422,
      message: 'workflow module did not export a default pipeline',
    })
  }
  const enforcement = gateway.enforcement
  const runner = new Runner({
    approvalGate: enforcement.approvalGate,
    secretResolver: enforcement.secretResolver,
    auditWriter: enforcement.auditWriter,
    store: gateway.runStore,
    events: gateway.events,
    workspaceManager: gateway.workspaceManager,
    ...(gateway.backends !== undefined && { backends: gateway.backends }),
  })
  gateway.attachMetricsBus(runner.events)
  gateway.attachOtelBus(runner.events)
  const controller = new AbortController()
  const runId = crypto.randomUUID()
  gateway.registerRun(runId, controller, runner)
  try {
    const handle = runner.start(pipeline as Parameters<Runner['start']>[0], input as never, {
      runId,
      signal: controller.signal,
      workflowPath: entry.path,
      skillSource: createSkillSource({
        registry: gateway.registries.skills,
        workflowPath: entry.path,
      }),
      pipelineRegistry: makeGatewayPipelineRegistry(gateway),
      ...gateway.defaultPermissionRunOptions(pipeline.id),
      ...gateway.defaultBackendRunOptions(pipeline.id),
      ...gateway.egressRunOptions(),
      ...gateway.agentmemoryRunOptions(),
      ...gateway.hitlRunOptions(),
      ...gateway.guardrailsRunOptions(),
    })
    const final = await handle.wait()
    return {
      runId: final.runId,
      status: final.status,
      output: final.output,
      ...(final.error !== undefined && { error: final.error }),
    }
  } finally {
    gateway.unregisterRun(runId)
  }
}
