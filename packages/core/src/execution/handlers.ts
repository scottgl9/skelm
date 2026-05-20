import {
  type AgentRequest,
  BackendCapabilityError,
  BackendNotFoundError,
  type BackendRegistry,
  type ContentPart,
  type SkelmBackend,
} from '../backend.js'
import { type ApprovalGate, EnvSecretResolver } from '../enforcement/index.js'
import {
  ApprovalDeniedError,
  BranchExhaustionError,
  InvokePipelineNotFoundError,
  PermissionDeniedError,
  RunCancelledError,
  StepKindError,
  StepTimeoutError,
  WaitConfigError,
  serializeError,
} from '../errors.js'
import { EventBus } from '../events.js'
import { createExec } from '../exec.js'
import { extractJsonFromText, tryParseJson } from '../json-utils.js'
import { createMcpHost } from '../mcp/host.js'
import type { AgentPermissions, NetworkPolicy, PermissionDimension } from '../permissions.js'
import { TrustEnforcer, createPolicyFetch, resolvePermissions } from '../permissions.js'
import { MemoryRunStore } from '../run-store.js'
import {
  adoptLastStepOutput,
  applyWorkspacePermissions,
  freezeContext,
  idempotentStateKey,
  isRetryableError,
  resolveIdempotentKey,
  restoreSerializedError,
  sleep,
  uniqueStrings,
} from '../runner-utils.js'
import { runPipeline } from '../runner.js'
import type { RunOptions, WaitRequest } from '../runner.js'
import { SchemaValidationError, validate } from '../schema.js'
import { createStateHandle } from '../state.js'
import { loadTsModule, pickExport } from '../ts-loader.js'
import type {
  Context,
  Pipeline,
  Run,
  Step,
  StepId,
  StepKind,
  StepResult,
  WorkspaceHandle,
} from '../types.js'
import { WorkspaceManager } from '../workspace.js'
import {
  assertBackendSupportsPermissions,
  collectDeclaredPermissionDimensions,
  collectResolvedPermissionDimensions,
  createDetachedWorkspaceRuntime,
  makeSkillLoader,
  resolveDeclaredSecrets,
} from './helpers.js'
import { createSecretsAccessor, resolveValueOrFn } from './internal.js'
import type { ExecutionRuntime } from './runtime.js'

const defaultStateStore = new MemoryRunStore()

export async function runStepWithRetry(
  step: Step,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events: EventBus,
  runtime: ExecutionRuntime,
): Promise<unknown> {
  const maxAttempts = step.retry?.maxAttempts ?? 1
  const backoffMultiplier = step.retry?.backoffMultiplier ?? 1
  let delayMs = step.retry?.delayMs ?? 0
  let attempt = 1

  while (true) {
    try {
      return await runStep(step, ctx, backends, waitForInput, events, runtime)
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryableError(err)) {
        throw err
      }
      events.publish({
        type: 'step.retry',
        runId: ctx.run.runId,
        stepId: step.id,
        kind: step.kind,
        attempt,
        error: serializeError(err),
        ...(delayMs > 0 && { delayMs }),
        at: Date.now(),
      })
      if (delayMs > 0) {
        await sleep(delayMs, ctx.signal)
      }
      attempt += 1
      delayMs *= backoffMultiplier
    }
  }
}
async function runStep(
  step: Step,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput?: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<unknown> {
  // Evaluate `when` on every dispatch site (top-level steps short-circuit
  // *before* this is reached so the top-level event sequence stays
  // `step.skipped`-only with no preceding `step.start`; nested steps
  // dispatched via parallel / forEach / branch / loop / idempotent /
  // pipelineStep land here and emit `step.skipped` for observability).
  if (step.when !== undefined) {
    const shouldRun = await step.when(ctx)
    if (!shouldRun) {
      events?.publish({
        type: 'step.skipped',
        runId: ctx.run.runId,
        stepId: step.id,
        kind: step.kind,
        at: Date.now(),
      })
      return undefined
    }
  }
  switch (step.kind) {
    case 'code':
      return await runCodeStep(step, ctx, runtime)
    case 'llm':
      return await runLlmStep(step, ctx, backends, events, runtime)
    case 'agent':
      return await runAgentStep(step, ctx, backends, waitForInput, events, runtime)
    case 'idempotent':
      return await runIdempotent(step, ctx, backends, waitForInput, events, runtime)
    case 'parallel':
      return await runParallel(step, ctx, backends, waitForInput, events, runtime)
    case 'forEach':
      return await runForEach(step, ctx, backends, waitForInput, events, runtime)
    case 'branch':
      return await runBranch(step, ctx, backends, waitForInput, events, runtime)
    case 'loop':
      return await runLoop(step, ctx, backends, waitForInput, events, runtime)
    case 'wait':
      return await runWait(step, ctx, waitForInput, events)
    case 'pipelineStep':
      return await runPipelineStep(step, ctx, backends, waitForInput, events, runtime)
    case 'invoke':
      return await runInvokeStep(step, ctx, backends, waitForInput, events, runtime)
    default: {
      const exhaustive: never = step
      throw new StepKindError((exhaustive as { kind: string }).kind)
    }
  }
}

async function runCodeStep(
  step: Extract<Step, { kind: 'code' }>,
  ctx: Context,
  runtime?: ExecutionRuntime,
): Promise<unknown> {
  const resolvedSecrets = await resolveDeclaredSecrets(
    step,
    undefined,
    runtime?.secretResolver,
    undefined,
    ctx.run.runId,
  )
  const secretsAccessor = createSecretsAccessor(resolvedSecrets)

  const policy = resolvePermissions(
    runtime?.defaultPermissions,
    step.permissions,
    runtime?.permissionProfiles ?? {},
  )
  const enforcer = new TrustEnforcer(policy)

  // Same per-step timeout pattern used by runAgentStep: chain a fresh
  // AbortController to ctx.signal so a runaway code step's budget aborts
  // ctx.signal and the wrapping promise rejects with StepTimeoutError.
  // Authors that ignore ctx.signal still lose the race; the run will not
  // block the gateway indefinitely.
  const stepController = step.timeoutMs !== undefined ? new AbortController() : undefined
  const stepSignal = stepController?.signal ?? ctx.signal
  const onParentAbort =
    stepController !== undefined ? () => stepController.abort(ctx.signal.reason) : undefined
  if (stepController !== undefined && onParentAbort !== undefined) {
    if (ctx.signal.aborted) stepController.abort(ctx.signal.reason)
    else ctx.signal.addEventListener('abort', onParentAbort, { once: true })
  }
  const timeoutMs = step.timeoutMs
  const timeoutHandle =
    timeoutMs !== undefined && stepController !== undefined
      ? setTimeout(() => stepController.abort(new StepTimeoutError(step.id, timeoutMs)), timeoutMs)
      : undefined

  const exec = createExec(enforcer, stepSignal)
  const stepCtx = freezeContext({
    ...ctx,
    signal: stepSignal,
    ...(secretsAccessor !== undefined && { secrets: secretsAccessor }),
    exec,
  })

  const runFn = await resolveCodeRun(step, runtime?.pipelineBaseDir)
  try {
    if (timeoutMs === undefined) return await runFn(stepCtx)
    return await Promise.race([
      Promise.resolve().then(() => runFn(stepCtx)),
      new Promise<never>((_resolve, reject) => {
        stepSignal.addEventListener(
          'abort',
          () => {
            if (stepSignal.reason instanceof StepTimeoutError) reject(stepSignal.reason)
          },
          { once: true },
        )
      }),
    ])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    if (onParentAbort !== undefined) ctx.signal.removeEventListener('abort', onParentAbort)
  }
}

async function resolveCodeRun(
  step: Extract<Step, { kind: 'code' }>,
  baseDir: string | undefined,
): Promise<(ctx: Context) => unknown | Promise<unknown>> {
  if (step.run !== undefined) return step.run
  if (step.module === undefined) {
    throw new Error(`code(${step.id}): neither "run" nor "module" is set`)
  }
  const mod = await loadTsModule(step.module, baseDir !== undefined ? { baseDir } : {})
  const exportName = step.export ?? 'default'
  const exported = pickExport(mod, exportName)
  if (typeof exported !== 'function') {
    throw new Error(
      `code(${step.id}): module "${step.module}" export "${exportName}" is not a function`,
    )
  }
  return exported as (ctx: Context) => unknown | Promise<unknown>
}

async function runLlmStep(
  step: Extract<Step, { kind: 'llm' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  events: EventBus | undefined,
  runtime?: ExecutionRuntime,
): Promise<unknown> {
  if (!backends) {
    throw new BackendNotFoundError(
      `step "${step.id}" requires a backend registry but none was provided to runPipeline()`,
    )
  }
  const backend = backends.resolveForLlm({ backendId: step.backend as string | undefined })
  const resolvedSecrets = await resolveDeclaredSecrets(
    step,
    undefined,
    runtime?.secretResolver,
    undefined,
    ctx.run.runId,
  )
  const secretsAccessor = createSecretsAccessor(resolvedSecrets)
  const stepCtx =
    secretsAccessor !== undefined ? freezeContext({ ...ctx, secrets: secretsAccessor }) : ctx
  const promptValue = resolveValueOrFn(step.prompt, stepCtx)
  const systemText = step.system === undefined ? undefined : resolveValueOrFn(step.system, stepCtx)
  const isMultimodalPrompt = Array.isArray(promptValue)
  if (isMultimodalPrompt && backend.capabilities.vision !== true) {
    throw new BackendCapabilityError(
      `step "${step.id}": backend "${backend.id}" does not support image content (capabilities.vision is not true). Route image prompts to a vision-capable backend (e.g. anthropic, openai).`,
      backend.id,
      'vision' as keyof import('../backend.js').BackendCapabilities,
    )
  }
  const req = {
    messages: [{ role: 'user' as const, content: promptValue as string | readonly ContentPart[] }],
    ...(systemText !== undefined && { system: systemText }),
    ...(step.model !== undefined && { model: step.model }),
    ...(step.temperature !== undefined && { temperature: step.temperature }),
    ...(step.maxTokens !== undefined && { maxTokens: step.maxTokens }),
    ...(step.outputSchema !== undefined && { outputSchema: step.outputSchema }),
  }
  const onPartial =
    events !== undefined
      ? (delta: string) => {
          events.publish({
            type: 'step.partial',
            runId: ctx.run.runId,
            stepId: step.id,
            kind: step.kind,
            delta,
            at: Date.now(),
          })
        }
      : undefined
  // biome-ignore lint/style/noNonNullAssertion: capability checked in resolveForLlm
  const response = await backend.infer!(req, {
    signal: stepCtx.signal,
    ...(onPartial !== undefined && { onPartial }),
  })
  if (step.outputSchema !== undefined) {
    const candidate = response.structured ?? response.text
    return await validate(step.outputSchema, candidate, 'output', {
      stepId: step.id,
      pipelineId: ctx.run.pipelineId,
    })
  }
  return { text: response.text ?? '', usage: response.usage }
}

async function runAgentStep(
  step: Extract<Step, { kind: 'agent' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events: EventBus | undefined,
  runtime: ExecutionRuntime | undefined,
): Promise<unknown> {
  if (!backends) {
    throw new BackendNotFoundError(
      `step "${step.id}" requires a backend registry but none was provided to runPipeline()`,
    )
  }
  const backend = backends.resolveForAgent({ backendId: step.backend as string | undefined })
  let preparedWorkspace: Awaited<ReturnType<WorkspaceManager['prepare']>> | undefined
  let finishedWorkspace = false
  try {
    const workspaceConfig =
      step.workspace === undefined ? undefined : resolveValueOrFn(step.workspace, ctx)
    preparedWorkspace =
      workspaceConfig === undefined
        ? undefined
        : await runtime?.workspaceManager.prepare({
            pipelineId: ctx.run.pipelineId,
            runId: ctx.run.runId,
            workspace: workspaceConfig,
          })
    const workspaceCtx =
      preparedWorkspace === undefined
        ? ctx
        : freezeContext({
            ...ctx,
            workspace: preparedWorkspace.handle,
          })
    // Resolve permissions + secrets FIRST so step.prompt / step.system /
    // step.mcp functions receive ctx.secrets, matching the contract that
    // runCodeStep and runLlmStep already implement. Without this ordering
    // agent steps see no secrets in their user-supplied callbacks.
    const policy =
      step.permissions !== undefined || step.mcp !== undefined || preparedWorkspace !== undefined
        ? resolvePermissions(
            runtime?.defaultPermissions,
            applyWorkspacePermissions(step.permissions, preparedWorkspace?.handle.path),
            runtime?.permissionProfiles,
          )
        : undefined
    const resolvedSecrets = await resolveDeclaredSecrets(
      step,
      policy,
      runtime?.secretResolver,
      events,
      ctx.run.runId,
    )
    const secretsAccessor = createSecretsAccessor(resolvedSecrets)
    const stepCtx =
      secretsAccessor !== undefined
        ? freezeContext({ ...workspaceCtx, secrets: secretsAccessor })
        : workspaceCtx
    const resolvedPromptText = resolveValueOrFn(step.prompt, stepCtx)
    const resolvedSystemText =
      step.system === undefined ? undefined : resolveValueOrFn(step.system, stepCtx)
    const mcpServers = step.mcp === undefined ? undefined : resolveValueOrFn(step.mcp, stepCtx)
    if (policy !== undefined && mcpServers !== undefined) {
      const enforcer = new TrustEnforcer(policy)
      for (const server of mcpServers) {
        const decision = enforcer.canAttachMcpServer(server.id)
        if (!decision.allow) {
          const detail = `step "${step.id}" is not allowed to attach MCP server "${server.id}" (${decision.reason})`
          events?.publish({
            type: 'permission.denied',
            runId: ctx.run.runId,
            stepId: step.id,
            dimension: 'mcp',
            detail,
            at: Date.now(),
          })
          throw new PermissionDeniedError(detail)
        }
      }
    }
    // Backend-capability fail-fast: publish permission.denied BEFORE the throw
    // so the runner's audit subscription (runner.ts:442-450) records it. Without
    // this the run still fails closed at the CLI/gateway boundary, but the
    // audit log stays silent — a deny event vanishes into the void, which is
    // what we explicitly avoid for any other dimension.
    if (mcpServers !== undefined && mcpServers.length > 0 && !backend.capabilities.mcp) {
      const detail = `backend ${backend.id} does not support per-step MCP attachments`
      events?.publish({
        type: 'permission.denied',
        runId: ctx.run.runId,
        stepId: step.id,
        dimension: 'mcp',
        detail,
        at: Date.now(),
      })
      throw new BackendCapabilityError(detail, backend.id, 'mcp')
    }
    if (step.skills !== undefined && step.skills.length > 0 && !backend.capabilities.skills) {
      const detail = `backend ${backend.id} does not support skill loading`
      events?.publish({
        type: 'permission.denied',
        runId: ctx.run.runId,
        stepId: step.id,
        dimension: 'skill',
        detail,
        at: Date.now(),
      })
      throw new BackendCapabilityError(detail, backend.id, 'skills')
    }
    const declaredPermissionDimensions = collectResolvedPermissionDimensions(policy, mcpServers)
    try {
      assertBackendSupportsPermissions(step.id, backend, declaredPermissionDimensions, {
        hasEgressProxy: runtime?.registerEgressToken !== undefined,
      })
    } catch (err) {
      if (err instanceof BackendCapabilityError) {
        events?.publish({
          type: 'permission.denied',
          runId: ctx.run.runId,
          stepId: step.id,
          dimension: 'tool',
          detail: err.message,
          at: Date.now(),
        })
      }
      throw err
    }
    if (policy?.approval && runtime?.approvalGate !== undefined) {
      const decision = await runtime.approvalGate.request({
        runId: ctx.run.runId,
        stepId: step.id,
        action: 'agent.start',
        context: Object.freeze({
          dimensions: Array.from(policy.approval.on),
          mcpServers: mcpServers?.map((m) => m.id) ?? [],
        }),
      })
      if (!decision.approved) {
        throw new ApprovalDeniedError(step.id, decision.approver, decision.reason)
      }
    }
    const req: AgentRequest = {
      prompt: resolvedPromptText,
      ...(resolvedSystemText !== undefined && { system: resolvedSystemText }),
      ...(step.maxTurns !== undefined && { maxTurns: step.maxTurns }),
      ...(preparedWorkspace !== undefined && { cwd: preparedWorkspace.handle.path }),
      ...(policy !== undefined && { permissions: policy }),
      ...(mcpServers !== undefined && { mcpServers }),
      ...(step.skills !== undefined && { skills: step.skills }),
      ...(resolvedSecrets !== undefined && { secrets: resolvedSecrets }),
      ...(step.outputSchema !== undefined && { outputSchema: step.outputSchema }),
      ...(step.systemPromptMode !== undefined && { systemPromptMode: step.systemPromptMode }),
      ...(step.systemPromptIncludeAgentDef !== undefined && {
        systemPromptIncludeAgentDef: step.systemPromptIncludeAgentDef,
      }),
    }
    const mcpHost =
      mcpServers !== undefined &&
      mcpServers.length > 0 &&
      backend.capabilities.toolPermissions === 'wrapped'
        ? await createMcpHost(mcpServers, {
            ...(policy !== undefined && { enforcer: new TrustEnforcer(policy) }),
            ...(events !== undefined && { events }),
            runId: ctx.run.runId,
            stepId: step.id,
          })
        : undefined
    // Register egress token if the callback is provided and network policy is declared.
    const egressToken =
      policy?.networkEgress !== undefined && runtime?.registerEgressToken !== undefined
        ? runtime.registerEgressToken(ctx.run.runId, step.id, policy.networkEgress)
        : undefined
    // Resolve per-step proxy env (HTTP_PROXY/HTTPS_PROXY with token credentials)
    // so subprocess backends can inject it into the spawned agent.
    const proxyEnv = runtime?.getProxyEnv?.(egressToken)
    try {
      // Policy-enforcing fetch wrapper: if the step declares a network
      // policy, wrap globalThis.fetch so outbound requests are checked
      // against the allowedHosts / deny setting before they go out.
      const policyFetch =
        policy !== undefined
          ? createPolicyFetch(
              new TrustEnforcer(policy),
              events !== undefined
                ? {
                    publish: (ev) => events.publish(ev),
                    runId: ctx.run.runId,
                    stepId: step.id,
                  }
                : undefined,
            )
          : undefined
      // Skill loader: gates each skill lookup through canLoadSkill so the
      // allowedSkills policy fires even for backends with native skill support.
      const loadSkill =
        runtime?.skillSource !== undefined && policy !== undefined
          ? makeSkillLoader(
              runtime.skillSource,
              new TrustEnforcer(policy),
              events,
              ctx.run.runId,
              step.id,
            )
          : undefined
      const onPartial =
        events !== undefined
          ? (delta: string) => {
              events.publish({
                type: 'step.partial',
                runId: ctx.run.runId,
                stepId: step.id,
                kind: step.kind,
                delta,
                at: Date.now(),
              })
            }
          : undefined
      // Per-step timeout: install an AbortController chained to ctx.signal so
      // a step.timeoutMs budget aborts the backend mid-run and surfaces as a
      // StepTimeoutError. Without this, backends that ignore the budget (e.g.
      // the native @skelm/agent loop) would run to completion regardless.
      const stepController = step.timeoutMs !== undefined ? new AbortController() : undefined
      const stepSignal = stepController?.signal ?? ctx.signal
      const onParentAbort =
        stepController !== undefined ? () => stepController.abort(ctx.signal.reason) : undefined
      if (stepController !== undefined && onParentAbort !== undefined) {
        if (ctx.signal.aborted) stepController.abort(ctx.signal.reason)
        else ctx.signal.addEventListener('abort', onParentAbort, { once: true })
      }
      const timeoutMs = step.timeoutMs
      const timeoutHandle =
        timeoutMs !== undefined && stepController !== undefined
          ? setTimeout(
              () => stepController.abort(new StepTimeoutError(step.id, timeoutMs)),
              timeoutMs,
            )
          : undefined
      let response: import('../backend.js').AgentResponse
      try {
        // biome-ignore lint/style/noNonNullAssertion: capability checked in resolveForAgent
        response = await backend.run!(req, {
          signal: stepSignal,
          ...(policy !== undefined && { permissions: policy }),
          ...(step.permissions !== undefined && { declaredPermissions: step.permissions }),
          ...(mcpHost !== undefined && { mcpHost }),
          ...(policyFetch !== undefined && { fetch: policyFetch }),
          ...(loadSkill !== undefined && { loadSkill }),
          ...(egressToken !== undefined && { egressToken }),
          ...(proxyEnv !== undefined && { proxyEnv }),
          ...(onPartial !== undefined && { onPartial }),
          // Plumb the runner's event bus + run/step identifiers so any
          // McpHost the backend brings up itself can publish tool.call /
          // tool.result events that the runner audits. Without this,
          // native-tool backends (toolPermissions:'native') leave no MCP
          // audit trail.
          ...(events !== undefined && { events }),
          runId: ctx.run.runId,
          stepId: step.id,
        })
      } catch (err) {
        if (stepSignal.aborted && stepSignal.reason instanceof StepTimeoutError) {
          throw stepSignal.reason
        }
        throw err
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
        if (onParentAbort !== undefined) ctx.signal.removeEventListener('abort', onParentAbort)
      }
      const candidate =
        step.outputSchema !== undefined
          ? (response.structured ?? extractJsonFromText(response.text))
          : undefined
      const result =
        step.outputSchema !== undefined
          ? await validate(step.outputSchema, candidate, 'output', {
              stepId: step.id,
              pipelineId: ctx.run.pipelineId,
              rawValue: response.text,
            })
          : {
              text: response.text ?? '',
              ...(response.usage !== undefined && { usage: response.usage }),
              ...(response.stopReason !== undefined && { stopReason: response.stopReason }),
            }
      await preparedWorkspace?.finishStep('completed')
      finishedWorkspace = true
      if (preparedWorkspace !== undefined) {
        const finalizedWorkspace = preparedWorkspace
        runtime?.setCurrentWorkspace(
          finalizedWorkspace.exposeAfterStep ? finalizedWorkspace.handle : undefined,
        )
        runtime?.deferRunWorkspaceFinalizer((status) => finalizedWorkspace.finishRun(status))
      }
      return result
    } finally {
      await mcpHost?.dispose()
      // Unregister egress token when the step completes.
      if (egressToken !== undefined && runtime?.unregisterEgressToken !== undefined) {
        runtime.unregisterEgressToken(ctx.run.runId, step.id)
      }
    }
  } catch (error) {
    if (!finishedWorkspace) {
      await preparedWorkspace?.finishStep('failed')
    }
    // PermissionDeniedError from the backend's own guard (e.g. Pi RPC defense-in-depth)
    // is not caught by the assertBackendSupportsPermissions block above, so it would
    // silently reach step.error without an auditable permission.denied event.
    if (error instanceof PermissionDeniedError && !(error instanceof BackendCapabilityError)) {
      events?.publish({
        type: 'permission.denied',
        runId: ctx.run.runId,
        stepId: step.id,
        dimension: 'tool',
        detail: error.message,
        at: Date.now(),
      })
    }
    throw error
  }
}

async function runParallel(
  step: Extract<Step, { kind: 'parallel' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<Record<string, unknown>> {
  const onError = step.onError ?? 'fail'
  warnOnSharedWorkspaces(step, ctx, events)
  const settled = await Promise.allSettled(
    step.steps.map((child) =>
      runStep(child, ctx, backends, waitForInput, events, createDetachedWorkspaceRuntime(runtime)),
    ),
  )
  const out: Record<string, unknown> = {}
  for (let i = 0; i < step.steps.length; i++) {
    const child = step.steps[i]
    const r = settled[i]
    if (child === undefined || r === undefined) continue
    if (r.status === 'fulfilled') {
      out[child.id] = r.value
    } else {
      if (onError === 'fail') {
        throw r.reason
      }
      // continue / partial: record the error shape; the run does not abort.
      out[child.id] = { error: serializeError(r.reason) }
    }
  }
  return out
}

function warnOnSharedWorkspaces(
  step: Extract<Step, { kind: 'parallel' }>,
  ctx: Context,
  events?: EventBus,
): void {
  if (events === undefined) return
  // Map workspace-key -> the child step ids that resolve to it. A "key" is
  // a string fingerprint of mode+identity that's robust enough to catch the
  // common shared-workspace mistake (mode: 'persistent', name: 'shared') and
  // mode: 'mounted' aliases. Step-resolved paths are not consulted here —
  // we just compare the declared identity.
  const keyToChildren = new Map<string, string[]>()
  for (const child of step.steps) {
    if (child.kind !== 'agent' || child.workspace === undefined) continue
    let cfg: ReturnType<typeof resolveWorkspaceConfig>
    try {
      cfg = resolveWorkspaceConfig(child.workspace, ctx)
    } catch (err) {
      // The factory threw evaluating against the parent ctx. We can't tell
      // if a workspace race would have occurred. Surface it as a separate
      // warning so the shared-workspace hazard is not silently hidden.
      events.publish({
        type: 'run.warning',
        runId: ctx.run.runId,
        stepId: step.id,
        code: 'parallel.workspace-resolve-failed',
        message: `parallel(${step.id}): workspace factory for child "${child.id}" threw during shared-workspace inspection: ${err instanceof Error ? err.message : String(err)}. The shared-workspace warning cannot be evaluated for this child.`,
        at: Date.now(),
      })
      continue
    }
    if (cfg === undefined) continue
    const key =
      cfg.mode === 'persistent'
        ? `persistent:${cfg.base ?? ''}:${cfg.name}`
        : cfg.mode === 'mounted'
          ? `mounted:${cfg.path}`
          : null
    if (key === null) continue
    const ids = keyToChildren.get(key)
    if (ids === undefined) keyToChildren.set(key, [child.id])
    else ids.push(child.id)
  }
  for (const [, ids] of keyToChildren) {
    if (ids.length < 2) continue
    events.publish({
      type: 'run.warning',
      runId: ctx.run.runId,
      stepId: step.id,
      code: 'parallel.shared-workspace',
      message: `parallel(${step.id}): children [${ids.join(', ')}] resolve to the same workspace; concurrent writes may race silently. Use workspace mode: 'ephemeral' per child to isolate.`,
      at: Date.now(),
    })
  }
}

function resolveWorkspaceConfig(
  workspace: NonNullable<Extract<Step, { kind: 'agent' }>['workspace']>,
  ctx: Context,
): import('../types.js').WorkspaceConfig | undefined {
  if (typeof workspace === 'function') return workspace(ctx)
  return workspace
}

async function runIdempotent(
  step: Extract<Step, { kind: 'idempotent' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<unknown> {
  const state = createStateHandle(runtime?.stateStore ?? defaultStateStore, {
    pipelineId: ctx.run.pipelineId,
    stepId: step.id,
    ...(step.state !== undefined && { config: step.state }),
  })
  const key = idempotentStateKey(resolveIdempotentKey(step.key, ctx))
  const cached = await state.get<{ value: unknown }>(key)
  if (cached !== undefined) {
    return cached.value
  }
  const value = await runStepWithRetry(
    step.step,
    ctx,
    backends,
    waitForInput,
    events ?? new EventBus(),
    {
      workspaceManager: runtime?.workspaceManager ?? new WorkspaceManager(),
      stateStore: runtime?.stateStore ?? defaultStateStore,
      ...(runtime?.store !== undefined && { store: runtime.store }),
      ...(runtime?.defaultPermissions !== undefined && {
        defaultPermissions: runtime.defaultPermissions,
      }),
      ...(runtime?.permissionProfiles !== undefined && {
        permissionProfiles: runtime.permissionProfiles,
      }),
      currentWorkspace: runtime?.currentWorkspace,
      setCurrentWorkspace: (workspace) => runtime?.setCurrentWorkspace(workspace),
      deferRunWorkspaceFinalizer: (finalizer) => runtime?.deferRunWorkspaceFinalizer(finalizer),
    },
  )
  await state.set(key, { value }, { ...(step.ttlMs !== undefined && { ttlMs: step.ttlMs }) })
  return value
}

async function runForEach(
  step: Extract<Step, { kind: 'forEach' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<unknown[]> {
  const items = step.items(ctx)
  const concurrency = step.concurrency ?? 1
  // Eagerly materialize per-iteration child steps so we can detect duplicate
  // ids (the natural factory pattern) before launching concurrent workers.
  // Duplicate ids would make the egress token key (runId:stepId) collide
  // across iterations: the first iteration to unregister deletes the token
  // out from under siblings still in flight, silently disabling network
  // policy enforcement. Suffix only the *colliding* ids with the iteration
  // index so non-colliding ids stay user-visible-unchanged.
  const children = new Array<Step>(items.length)
  const idCounts = new Map<string, number>()
  for (let i = 0; i < items.length; i++) {
    const child = step.step(items[i], i)
    idCounts.set(child.id, (idCounts.get(child.id) ?? 0) + 1)
    children[i] = child
  }
  if (concurrency > 1) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as Step
      if ((idCounts.get(child.id) ?? 0) > 1) {
        children[i] = { ...child, id: `${child.id}#${i}` } as Step
      }
    }
  }
  const results = new Array<unknown>(items.length)
  let cursor = 0
  const workers: Promise<void>[] = []
  const launch = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++
      const item = items[i]
      const child = children[i] as Step
      const itemCtx = freezeContext({ ...ctx, item })
      results[i] = await runStep(
        child,
        itemCtx,
        backends,
        waitForInput,
        events,
        createDetachedWorkspaceRuntime(runtime),
      )
    }
  }
  const lanes = Math.min(concurrency, items.length || 1)
  for (let n = 0; n < lanes; n++) {
    workers.push(launch())
  }
  await Promise.all(workers)
  return results
}

async function runBranch(
  step: Extract<Step, { kind: 'branch' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<unknown> {
  const key = step.on(ctx)
  const chosen = step.cases[key] ?? step.default
  if (chosen === undefined) {
    throw new BranchExhaustionError(step.id, key)
  }
  return await runStep(chosen, ctx, backends, waitForInput, events, runtime)
}

async function runLoop(
  step: Extract<Step, { kind: 'loop' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<{ iterations: unknown[]; last: unknown }> {
  const iterations: unknown[] = []
  let last: unknown
  // Rebuild ctx each iteration so step.while and the child step can read
  // ctx.steps[step.id] = the accumulated output so far.
  let iterCtx = ctx
  for (let i = 0; i < step.maxIterations; i++) {
    if (!(await step.while(iterCtx))) break
    last = await runStep(step.step, iterCtx, backends, waitForInput, events, runtime)
    iterations.push(last)
    // Inject the running loop result so subsequent iterations see updated state.
    iterCtx = freezeContext({
      ...iterCtx,
      steps: {
        ...iterCtx.steps,
        [step.id]: { iterations, last, ...((last as Record<string, unknown>) ?? {}) },
      },
    })
  }
  return { iterations, last, ...(last !== null && typeof last === 'object' ? last : {}) }
}

async function runWait(
  step: Extract<Step, { kind: 'wait' }>,
  ctx: Context,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
): Promise<unknown> {
  if (!waitForInput) {
    throw new WaitConfigError(step.id)
  }
  const message = step.message === undefined ? undefined : resolveValueOrFn(step.message, ctx)
  events?.publish({
    type: 'run.waiting',
    runId: ctx.run.runId,
    stepId: step.id,
    ...(message !== undefined && { message }),
    ...(step.timeoutMs !== undefined && { timeoutMs: step.timeoutMs }),
    at: Date.now(),
  })
  const resumed = await waitForInput({
    runId: ctx.run.runId,
    pipelineId: ctx.run.pipelineId,
    stepId: step.id,
    signal: ctx.signal,
    ...(message !== undefined && { message }),
    ...(step.timeoutMs !== undefined && { timeoutMs: step.timeoutMs }),
    ...(step.outputSchema !== undefined && { outputSchema: step.outputSchema }),
  })
  events?.publish({
    type: 'run.resumed',
    runId: ctx.run.runId,
    stepId: step.id,
    output: resumed,
    at: Date.now(),
  })
  if (step.outputSchema !== undefined) {
    return await validate(step.outputSchema, resumed, 'output', {
      stepId: step.id,
      pipelineId: ctx.run.pipelineId,
    })
  }
  return resumed
}

async function runInvokeStep(
  step: Extract<Step, { kind: 'invoke' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<unknown> {
  const pipeline = await runtime?.pipelineRegistry?.(step.pipelineId)
  if (pipeline === undefined) {
    throw new InvokePipelineNotFoundError(step.pipelineId, step.id)
  }
  const nestedInput = step.input === undefined ? ctx.input : resolveValueOrFn(step.input, ctx)
  const nestedRun = await runPipeline(pipeline, nestedInput, {
    signal: ctx.signal,
    ...(events !== undefined && { events }),
    ...(backends !== undefined && { backends }),
    ...(runtime?.store !== undefined && { store: runtime.store }),
    ...(runtime?.stateStore !== undefined && { stateStore: runtime.stateStore }),
    ...(runtime?.defaultPermissions !== undefined && {
      defaultPermissions: runtime.defaultPermissions,
    }),
    ...(runtime?.permissionProfiles !== undefined && {
      permissionProfiles: runtime.permissionProfiles,
    }),
    ...(runtime?.workspaceManager !== undefined && { workspaceManager: runtime.workspaceManager }),
    ...(runtime?.skillSource !== undefined && { skillSource: runtime.skillSource }),
    ...(runtime?.secretResolver !== undefined && { secretResolver: runtime.secretResolver }),
    ...(runtime?.pipelineRegistry !== undefined && { pipelineRegistry: runtime.pipelineRegistry }),
    ...(waitForInput !== undefined && { waitForInput }),
  })
  if (nestedRun.status === 'completed') {
    return nestedRun.output
  }
  if (nestedRun.status === 'cancelled') {
    throw new RunCancelledError(
      `invoke(${step.id}): nested pipeline "${pipeline.id}" was cancelled`,
    )
  }
  throw restoreSerializedError(
    nestedRun.error,
    `invoke(${step.id}): nested pipeline "${pipeline.id}" did not complete`,
  )
}

async function runPipelineStep(
  step: Extract<Step, { kind: 'pipelineStep' }>,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events?: EventBus,
  runtime?: ExecutionRuntime,
): Promise<unknown> {
  const nestedInput = step.input === undefined ? ctx.input : resolveValueOrFn(step.input, ctx)
  const nestedRun = await runPipeline(step.pipeline, nestedInput, {
    signal: ctx.signal,
    ...(events !== undefined && { events }),
    ...(backends !== undefined && { backends }),
    ...(runtime?.store !== undefined && { store: runtime.store }),
    ...(runtime?.stateStore !== undefined && { stateStore: runtime.stateStore }),
    ...(runtime?.defaultPermissions !== undefined && {
      defaultPermissions: runtime.defaultPermissions,
    }),
    ...(runtime?.permissionProfiles !== undefined && {
      permissionProfiles: runtime.permissionProfiles,
    }),
    ...(runtime?.workspaceManager !== undefined && { workspaceManager: runtime.workspaceManager }),
    ...(runtime?.skillSource !== undefined && { skillSource: runtime.skillSource }),
    ...(runtime?.secretResolver !== undefined && { secretResolver: runtime.secretResolver }),
    ...(runtime?.pipelineRegistry !== undefined && { pipelineRegistry: runtime.pipelineRegistry }),
    ...(waitForInput !== undefined && { waitForInput }),
  })
  if (nestedRun.status === 'completed') {
    return nestedRun.output
  }
  if (nestedRun.status === 'cancelled') {
    throw new RunCancelledError(
      `pipelineStep(${step.id}): nested pipeline "${step.pipeline.id}" was cancelled`,
    )
  }
  throw restoreSerializedError(
    nestedRun.error,
    `pipelineStep(${step.id}): nested pipeline "${step.pipeline.id}" did not complete`,
  )
}
