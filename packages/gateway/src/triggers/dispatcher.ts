import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { type BackendRegistry, type RunEvent, Runner, isPersistentAgent } from '@skelm/core'
import { makeGatewayPipelineRegistry } from '../http/routes/utils.js'
import type { Gateway } from '../lifecycle/gateway.js'
import { runPersistentTurn } from './persistent-turn.js'
import type { FireContext, RunCallback } from './types.js'

/**
 * Loader that turns a workflow registry id (the path relative to the project
 * root) into a runnable pipeline. The CLI wires this to native `import()`; tests
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
 *   loadWorkflow: async (_id, abs) => (await import(pathToFileURL(abs).href)).default,
 * })
 * gateway.managers.triggers.register({...})  // onFire was wired to dispatcher
 * ```
 */
export function createTriggerDispatcher(opts: CreateDispatcherOptions): RunCallback {
  return async (ctx: FireContext): Promise<void> => {
    let runId: string | null = null
    try {
      // A schedule's workflowId is normally a registry id, but `POST
      // /schedules` (and the manual schedule flows it backs) accept an
      // absolute path to a workflow file the gateway never glob-indexed.
      // Resolving only against the registry left those fires reporting
      // `dispatched` while the dispatch threw `workflow not registered` and
      // produced no Run. Fall back to the absolute path itself when it points
      // at an existing file so the loader can import it directly.
      const entry = opts.gateway.registries.workflows.get(ctx.workflowId)
      const workflowPath =
        entry?.path ??
        (isAbsolute(ctx.workflowId) && existsSync(ctx.workflowId) ? ctx.workflowId : undefined)
      if (workflowPath === undefined) {
        throw new Error(`workflow not registered: ${ctx.workflowId}`)
      }
      const exported = await opts.loadWorkflow(ctx.workflowId, workflowPath)

      // Persistent agents are not pipelines: a fire runs one enforced turn that
      // loads/saves a durable conversation rather than a fresh pipeline run. The
      // turn runner owns its own Run registration, so `runId` stays null here.
      let output: unknown
      const target = isPersistentAgent(exported) ? exported : extractDefault(exported)
      const persistentTarget = isPersistentAgent(target)
        ? (target as Parameters<typeof runPersistentTurn>[0]['agent'])
        : undefined
      if (persistentTarget !== undefined) {
        // A persistentAgent multiplexes over independent durable sessions
        // (one per sessionKey), so two queued fires for distinct sessionKeys
        // are NOT racing the same resource and must not be serialized at
        // the trigger level. Tell the coordinator to bypass its inflight
        // gate from here on; same-session ordering is preserved by
        // runPersistentTurn's per-(workflowId, sessionKey) lock.
        opts.gateway.managers.triggers.markParallel(ctx.triggerId)
        // Forward run events to the queue driver live (onEvent) so a frontend
        // can stream the turn as it's generated, before the final onResult.
        const evReg = opts.gateway.managers.triggers.get(ctx.triggerId)
        const evDriver =
          evReg !== undefined && evReg.spec.kind === 'queue' && ctx.payload !== undefined
            ? opts.gateway.managers.triggers.getQueueDriver(
                (evReg.spec as { driver?: string }).driver ?? '',
              )
            : undefined
        const onEvent: ((event: RunEvent) => void) | undefined =
          evDriver?.onEvent !== undefined
            ? (event) => {
                try {
                  void evDriver.onEvent?.(ctx.payload, event)
                } catch (err) {
                  opts.onError?.(err as Error, ctx)
                }
              }
            : undefined
        const turn = await runPersistentTurn({
          gateway: opts.gateway,
          agent: persistentTarget,
          payload: ctx.payload,
          triggerId: ctx.triggerId,
          ...(opts.backends !== undefined && { backends: opts.backends }),
          ...(onEvent !== undefined && { onEvent }),
        })
        output = turn.output
      } else {
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
          workspaceManager: opts.gateway.workspaceManager,
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
          ctx.payload !== undefined
            ? ctx.payload
            : { triggerId: ctx.triggerId, firedAt: ctx.firedAt }
        const handle = runner.start(pipeline as Parameters<Runner['start']>[0], pipelineInput, {
          runId,
          signal: controller.signal,
          workflowPath,
          triggerId: ctx.triggerId,
          unrestrictedGrant: opts.gateway.isUnrestrictedGranted(ctx.workflowId),
          ...opts.gateway.defaultPermissionRunOptions(),
          ...opts.gateway.egressRunOptions(),
          ...opts.gateway.agentmemoryRunOptions(),
          beforeStep: async (info) => {
            if (breakpoints.has(info.stepId)) {
              await breakpoints.pause({ runId: info.runId, stepId: info.stepId, kind: info.kind })
            }
          },
          pipelineRegistry: makeGatewayPipelineRegistry(opts.gateway),
        })
        const result = await handle.wait()
        output = (result as { output?: unknown }).output
      }

      // If the trigger came from a queue driver that wants to react to the
      // run's output (e.g. post a reply), invoke its onResult hook.
      const reg = opts.gateway.managers.triggers.get(ctx.triggerId)
      if (reg !== undefined && reg.spec.kind === 'queue' && ctx.payload !== undefined) {
        const driverId = reg.spec.driver
        const driver = opts.gateway.managers.triggers.getQueueDriver(driverId)
        if (driver?.onResult !== undefined) {
          try {
            await driver.onResult(ctx.payload, output)
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
  if (isPipelineish(m.default) || isPersistentAgent(m.default)) return m.default
  return undefined
}
