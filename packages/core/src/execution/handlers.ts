import {
  type AgentRequest,
  BackendCapabilityError,
  BackendNotFoundError,
  type BackendRegistry,
  type SkelmBackend,
} from '../backend.js'
import { type ApprovalGate, EnvSecretResolver } from '../enforcement/index.js'
import {
  ApprovalDeniedError,
  InvokePipelineNotFoundError,
  PermissionDeniedError,
  RunCancelledError,
  StepTimeoutError,
  serializeError,
} from '../errors.js'
import { EventBus } from '../events.js'
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
      throw new Error(`unknown step kind: ${(exhaustive as { kind: string }).kind}`)
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
  const secretsAccessor =
    resolvedSecrets !== undefined
      ? {
          get: (name: string) => resolvedSecrets[name],
        }
      : undefined
  const stepCtx =
    secretsAccessor !== undefined ? freezeContext({ ...ctx, secrets: secretsAccessor }) : ctx
  return await step.run(stepCtx)
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
  const secretsAccessor =
    resolvedSecrets !== undefined
      ? {
          get: (name: string) => resolvedSecrets[name],
        }
      : undefined
  const stepCtx =
    secretsAccessor !== undefined ? freezeContext({ ...ctx, secrets: secretsAccessor }) : ctx
  const promptText = typeof step.prompt === 'function' ? step.prompt(stepCtx) : step.prompt
  const systemText =
    step.system === undefined
      ? undefined
      : typeof step.system === 'function'
        ? step.system(stepCtx)
        : step.system
  const req = {
    messages: [{ role: 'user' as const, content: promptText }],
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
      step.workspace === undefined
        ? undefined
        : typeof step.workspace === 'function'
          ? step.workspace(ctx)
          : step.workspace
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
    const secretsAccessor =
      resolvedSecrets !== undefined ? { get: (name: string) => resolvedSecrets[name] } : undefined
    const stepCtx =
      secretsAccessor !== undefined
        ? freezeContext({ ...workspaceCtx, secrets: secretsAccessor })
        : workspaceCtx
    const resolvedPromptText =
      typeof step.prompt === 'function' ? step.prompt(stepCtx) : step.prompt
    const resolvedSystemText =
      step.system === undefined
        ? undefined
        : typeof step.system === 'function'
          ? step.system(stepCtx)
          : step.system
    const mcpServers =
      step.mcp === undefined
        ? undefined
        : typeof step.mcp === 'function'
          ? step.mcp(stepCtx)
          : step.mcp
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
    if (mcpServers !== undefined && mcpServers.length > 0 && !backend.capabilities.mcp) {
      throw new BackendCapabilityError(
        `backend ${backend.id} does not support per-step MCP attachments`,
        backend.id,
        'mcp',
      )
    }
    if (step.skills !== undefined && step.skills.length > 0 && !backend.capabilities.skills) {
      throw new BackendCapabilityError(
        `backend ${backend.id} does not support skill loading`,
        backend.id,
        'skills',
      )
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
      const timeoutHandle =
        step.timeoutMs !== undefined && stepController !== undefined
          ? setTimeout(
              () => stepController.abort(new StepTimeoutError(step.id, step.timeoutMs!)),
              step.timeoutMs,
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
  const results = new Array<unknown>(items.length)
  let cursor = 0
  const workers: Promise<void>[] = []
  const launch = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++
      const item = items[i]
      const child = step.step(item, i)
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
    throw new Error(`branch(${step.id}): no case matched "${key}" and no default was provided`)
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
    throw new Error(
      `wait(${step.id}): no wait handler configured; use Runner.start() or pass waitForInput to runPipeline()`,
    )
  }
  const message =
    step.message === undefined
      ? undefined
      : typeof step.message === 'function'
        ? step.message(ctx)
        : step.message
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
  const nestedInput =
    step.input === undefined
      ? ctx.input
      : typeof step.input === 'function'
        ? step.input(ctx)
        : step.input
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
  const nestedInput =
    step.input === undefined
      ? ctx.input
      : typeof step.input === 'function'
        ? step.input(ctx)
        : step.input
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
