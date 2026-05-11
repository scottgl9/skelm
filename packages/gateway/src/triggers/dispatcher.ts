import { type BackendRegistry, Runner } from '@skelm/core'
import { makeGatewayPipelineRegistry } from '../http/routes/utils.js'
import type { Gateway } from '../lifecycle/gateway.js'
import type { FireContext, RunCallback } from './types.js'

/**
 * Loader that turns a workflow registry id (the path relative to the project
 * root) into a runnable pipeline. The CLI wires this to `tsImport()`; tests
 * supply a fake loader so they don't need a real workspace.
 */
export type WorkflowLoader = (registryId: string, absolutePath: string) => Promise<unknown>

export interface CreateDispatcherOptions {
  gateway: Gateway
  loadWorkflow: WorkflowLoader
  /**
   * Pre-built backend instances to register for dispatched runs. Consumers
   * pass `config.instances` here so triggered workflows can use agent() steps.
   */
  backends?: BackendRegistry
  /**
   * Hook for tests to observe dispatcher errors. Defaults to swallowing —
   * the trigger coordinator already records onFire errors as `lastError`
   * on the registration, so the run loop continues.
   */
  onError?: (err: Error, ctx: FireContext) => void
}

/**
 * Build a `RunCallback` that resolves a fired trigger's `workflowId` against
 * the gateway's workflow registry, imports the module via the supplied loader,
 * and starts a Runner with the gateway's enforcement instances.
 *
 * Usage:
 *
 * ```ts
 * const dispatcher = createTriggerDispatcher({
 *   gateway,
 *   loadWorkflow: async (_id, abs) => (await tsImport(abs, ...)).default,
 * })
 * gateway.managers.triggers.register({...})  // onFire was wired to dispatcher
 * ```
 */
export function createTriggerDispatcher(opts: CreateDispatcherOptions): RunCallback {
  return async (ctx: FireContext): Promise<void> => {
    let runId: string | null = null
    try {
      const entry = opts.gateway.registries.workflows.get(ctx.workflowId)
      if (entry === undefined) {
        throw new Error(`workflow not registered: ${ctx.workflowId}`)
      }
      const exported = await opts.loadWorkflow(ctx.workflowId, entry.path)
      const pipeline = isPipelineish(exported) ? exported : extractDefault(exported)
      if (pipeline === undefined) {
        throw new Error(`workflow ${ctx.workflowId} did not export a default pipeline`)
      }
      const enforcement = opts.gateway.enforcement
      const runner = new Runner({
        approvalGate: enforcement.approvalGate,
        secretResolver: enforcement.secretResolver,
        auditWriter: enforcement.auditWriter,
        store: opts.gateway.runStore,
        ...(opts.backends !== undefined && { backends: opts.backends }),
      })
      // Feed step events into the metrics collector if enabled.
      opts.gateway.attachMetricsBus(runner.events)
      opts.gateway.metrics?.recordTriggerFire(ctx.triggerId)
      const controller = new AbortController()
      runId = crypto.randomUUID()
      opts.gateway.registerRun(runId, controller, runner)
      const breakpoints = opts.gateway.breakpoints
      const pipelineInput =
        ctx.payload !== undefined ? ctx.payload : { triggerId: ctx.triggerId, firedAt: ctx.firedAt }
      const handle = runner.start(pipeline as Parameters<Runner['start']>[0], pipelineInput, {
        runId,
        signal: controller.signal,
        workflowPath: entry.path,
        registerEgressToken: (runId, stepId, policy) =>
          opts.gateway.registerEgressToken(runId, stepId, policy),
        unregisterEgressToken: (runId, stepId) => opts.gateway.unregisterEgressToken(runId, stepId),
        getProxyEnv: (egressToken) => opts.gateway.getProxyEnvVars(egressToken),
        beforeStep: async (info) => {
          if (breakpoints.has(info.stepId)) {
            await breakpoints.pause({ runId: info.runId, stepId: info.stepId, kind: info.kind })
          }
        },
        pipelineRegistry: makeGatewayPipelineRegistry(opts.gateway),
      })
      const result = await handle.wait()
      // If the trigger came from a queue driver that wants to react to the
      // run's output (e.g. post a reply), invoke its onResult hook.
      const reg = opts.gateway.managers.triggers.get(ctx.triggerId)
      if (reg !== undefined && reg.spec.kind === 'queue' && ctx.payload !== undefined) {
        const driverId = reg.spec.driver
        const driver = opts.gateway.managers.triggers.getQueueDriver(driverId)
        if (driver?.onResult !== undefined) {
          try {
            await driver.onResult(ctx.payload, (result as { output?: unknown }).output)
          } catch (err) {
            opts.onError?.(err as Error, ctx)
          }
        }
      }
    } catch (err) {
      opts.onError?.(err as Error, ctx)
      throw err
    } finally {
      if (runId !== null) opts.gateway.unregisterRun(runId)
    }
  }
}

function isPipelineish(value: unknown): value is { steps: readonly unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'steps' in value &&
    Array.isArray((value as { steps: unknown }).steps)
  )
}

function extractDefault(mod: unknown): unknown {
  if (typeof mod !== 'object' || mod === null) return undefined
  const m = mod as Record<string, unknown>
  if (isPipelineish(m.default)) return m.default
  return undefined
}
