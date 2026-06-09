import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { type BackendRegistry, type RunEvent, Runner, isPersistentWorkflow } from '@skelm/core'
import { makeGatewayPipelineRegistry } from '../http/routes/utils.js'
import type { GatewayContext } from '../lifecycle/gateway-types.js'
import { runPersistentWorkflowTurn } from './persistent-workflow-turn.js'
import type { FireContext, RunCallback } from './types.js'

/**
 * Loader that turns a workflow registry id (the path relative to the project
 * root) into a runnable pipeline. The CLI wires this to native `import()`; tests
 * supply a fake loader so they don't need a real workspace.
 */
export type WorkflowLoader = (registryId: string, absolutePath: string) => Promise<unknown>

export interface CreateDispatcherOptions {
  gateway: GatewayContext
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

      // A persistent workflow runs one enforced turn that loads/saves a durable
      // conversation rather than a fresh stateless pipeline run. The turn runner
      // owns its own Run registration, so `runId` stays null here. NOTE: a
      // persistent workflow with preamble `steps` also satisfies isPipelineish,
      // so it MUST be discriminated by `kind` (isPersistentWorkflow) FIRST.
      let output: unknown
      // Forward run events to the bound queue driver's onEvent hook (if any) so a
      // streaming frontend (e.g. a TUI) can render the run live, before the final
      // onResult. This applies to BOTH persistent-workflow turns and plain
      // queue-triggered pipelines — the QueueDriver.onEvent contract is the same
      // on every queue path.
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
      const target = isPersistentWorkflow(exported) ? exported : extractDefault(exported)
      const persistentTarget = isPersistentWorkflow(target)
        ? (target as Parameters<typeof runPersistentWorkflowTurn>[0]['workflow'])
        : undefined
      if (persistentTarget !== undefined) {
        // A persistent workflow multiplexes over independent durable sessions
        // (one per sessionKey), so two queued fires for distinct sessionKeys
        // are NOT racing the same resource and must not be serialized at
        // the trigger level. Tell the coordinator to bypass its inflight
        // gate from here on; same-session ordering is preserved by
        // runPersistentWorkflowTurn's per-(workflowId, sessionKey) lock.
        opts.gateway.managers.triggers.markParallel(ctx.triggerId)
        // Resolve the live gateway registry first, falling back to the
        // constructor-passed one. The fallback is NOT dead: the gateway's
        // registry may be absorbed lazily during project activation (a gateway
        // booted without backends gains them via Gateway.absorbBackends), and
        // reading `gateway.backends` at fire time picks up those additions —
        // whereas `opts.backends` is the registry captured when the dispatcher
        // was wired. Keep both.
        const turn = await runPersistentWorkflowTurn({
          gateway: opts.gateway,
          workflow: persistentTarget,
          payload: ctx.payload,
          triggerId: ctx.triggerId,
          workflowPath,
          ...((opts.gateway.backends ?? opts.backends) !== undefined && {
            backends: opts.gateway.backends ?? opts.backends,
          }),
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
          // Live registry first, constructor registry as fallback (see above).
          ...((opts.gateway.backends ?? opts.backends) !== undefined && {
            backends: opts.gateway.backends ?? opts.backends,
          }),
        })
        // Feed step events into the metrics collector + OTel tracer if enabled.
        opts.gateway.attachMetricsBus(runner.events)
        opts.gateway.attachOtelBus(runner.events)
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
          // Use the LOADED workflow's declared id, not the trigger spec's
          // workflowId (which can be the registry id / file path). The
          // per-workflow ceiling registered on activation keys on the
          // declared id; persistent-workflow-turn does the same.
          ...opts.gateway.defaultPermissionRunOptions(
            typeof (pipeline as { id?: unknown }).id === 'string'
              ? (pipeline as { id: string }).id
              : ctx.workflowId,
          ),
          ...opts.gateway.defaultBackendRunOptions(
            typeof (pipeline as { id?: unknown }).id === 'string'
              ? (pipeline as { id: string }).id
              : ctx.workflowId,
          ),
          ...opts.gateway.egressRunOptions(),
          ...opts.gateway.agentmemoryRunOptions(),
          ...(onEvent !== undefined && { onEvent }),
          beforeStep: async (info) => {
            if (breakpoints.has(info.stepId)) {
              await breakpoints.pause({ runId: info.runId, stepId: info.stepId, kind: info.kind })
            }
          },
          pipelineRegistry: makeGatewayPipelineRegistry(opts.gateway),
        })
        const result = await handle.wait()
        if (result.status !== 'completed') {
          const err = result.error as { message?: string } | undefined
          throw new Error(err?.message ?? `triggered run ${runId} ${result.status}`)
        }
        output = result.output
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

// NOTE: a persistent workflow with preamble `steps` ALSO has a `steps` array, so
// this is not a sufficient discriminator on its own — always check
// isPersistentWorkflow (the `kind` discriminator) first when routing a fire.
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
  if (isPersistentWorkflow(m.default) || isPipelineish(m.default)) return m.default
  return undefined
}
