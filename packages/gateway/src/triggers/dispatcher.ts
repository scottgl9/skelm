import { Runner } from '@skelm/core'
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
      })
      const handle = runner.start(pipeline as Parameters<Runner['start']>[0], {
        triggerId: ctx.triggerId,
        firedAt: ctx.firedAt,
      })
      await handle.wait()
    } catch (err) {
      opts.onError?.(err as Error, ctx)
      throw err
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
