import pRetry, { AbortError as RetryAbortError } from 'p-retry'
import { loadAgentDefinition } from '../agent-def.js'
import {
  type AgentRequest,
  BackendCapabilityError,
  type BackendId,
  BackendNotFoundError,
  type BackendRegistry,
  BackendUnavailableError,
  type ContentPart,
  type DelegateResult,
  type SkelmBackend,
} from '../backend.js'
import { type ApprovalGate, EnvSecretResolver } from '../enforcement/index.js'
import {
  ApprovalDeniedError,
  BranchExhaustionError,
  DEFAULT_MAX_DELEGATION_DEPTH,
  DelegationCycleError,
  DelegationDepthError,
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
import type { McpServerConfig } from '../mcp/types.js'
import type {
  AgentPermissions,
  NetworkPolicy,
  PermissionDimension,
  ResolvedPolicy,
} from '../permissions.js'
import {
  TrustEnforcer,
  createPolicyFetch,
  intersectResolvedPolicies,
  resolvePermissions,
} from '../permissions.js'
import { MemoryRunStore } from '../run-store.js'
import {
  adoptLastStepOutput,
  applyWorkspacePermissions,
  freezeContext,
  idempotentStateKey,
  isRetryableError,
  resolveIdempotentKey,
  restoreSerializedError,
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
  collectResolvedPermissionDimensions,
  createDetachedWorkspaceRuntime,
  makeSkillLoader,
  resolveDeclaredSecrets,
} from './helpers.js'
import { createSecretsAccessor, resolveValueOrFn, resolveValueOrFnAsync } from './internal.js'
import type { ExecutionRuntime } from './runtime.js'

const defaultStateStore = new MemoryRunStore()
const auditedPermissionDenials = new WeakSet<PermissionDeniedError>()
const IDEMPOTENT_PENDING_POLL_MS = 10

type IdempotentCacheEntry = { value: unknown } | { status: 'pending'; owner: string }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function markPermissionDeniedAudited(error: PermissionDeniedError): PermissionDeniedError {
  auditedPermissionDenials.add(error)
  return error
}

function backendCandidates(
  requested: string | readonly string[] | undefined,
): readonly BackendId[] | undefined {
  if (requested === undefined) return undefined
  if (typeof requested === 'string') return [requested]
  return requested.filter((id) => id.length > 0)
}

function noAvailableBackendError(
  stepId: string,
  kind: 'infer' | 'agent',
  attempted: readonly string[],
  lastUnavailable: BackendUnavailableError | undefined,
): Error {
  if (attempted.length === 0) {
    return new BackendNotFoundError(`step "${stepId}" specified an empty backend list`)
  }
  const detail = attempted.join(', ')
  if (lastUnavailable !== undefined) {
    return new BackendUnavailableError(
      `step "${stepId}" could not run ${kind} step: no specified backend is available (tried: ${detail}). Last error: ${lastUnavailable.message}`,
      lastUnavailable.backendId,
    )
  }
  return new BackendNotFoundError(
    `step "${stepId}" could not run ${kind} step: no specified backend is available (tried: ${detail})`,
  )
}

function emitBackendFailover(
  events: EventBus | undefined,
  input: {
    runId: string
    stepId: string
    kind: 'infer' | 'agent'
    from: string
    to: string
    error: BackendUnavailableError
  },
): void {
  events?.publish({
    type: 'backend.failover',
    runId: input.runId,
    stepId: input.stepId,
    kind: input.kind,
    from: input.from,
    to: input.to,
    error: input.error.message,
    at: Date.now(),
  })
}

// Emit the audit signal for an operator-granted full bypass. Called once per
// step whose resolved policy is `unrestricted`, so the short-circuit is never
// silent (see docs/concepts/permissions.md). The runner's audit subscription
// turns this into a durable AuditWriter entry.
function emitBypassIfUnrestricted(
  policy: ResolvedPolicy,
  events: EventBus | undefined,
  runId: string,
  stepId: string,
): void {
  if (policy.unrestricted !== true || events === undefined) return
  events.publish({
    type: 'permission.bypassed',
    runId,
    stepId,
    detail: `step "${stepId}" running UNRESTRICTED (operator-granted full permission bypass)`,
    at: Date.now(),
  })
}

export async function runStepWithRetry(
  step: Step,
  ctx: Context,
  backends: BackendRegistry | undefined,
  waitForInput: RunOptions['waitForInput'],
  events: EventBus,
  runtime: ExecutionRuntime,
): Promise<unknown> {
  const maxAttempts = step.retry?.maxAttempts ?? 1
  let abortedOriginal: unknown

  try {
    return await pRetry(
      async () => {
        try {
          return await runStep(step, ctx, backends, waitForInput, events, runtime)
        } catch (err) {
          if (!isRetryableError(err)) {
            abortedOriginal = err
            throw new RetryAbortError(err instanceof Error ? err : new Error(String(err)))
          }
          throw err
        }
      },
      {
        retries: maxAttempts - 1,
        factor: step.retry?.backoffMultiplier ?? 1,
        minTimeout: step.retry?.delayMs ?? 0,
        maxTimeout: Number.POSITIVE_INFINITY,
        randomize: false,
        signal: ctx.signal,
        unref: true,
        onFailedAttempt: ({ error, attemptNumber, retryDelay }) => {
          events.publish({
            type: 'step.retry',
            runId: ctx.run.runId,
            stepId: step.id,
            kind: step.kind,
            attempt: attemptNumber,
            error: serializeError(error),
            ...(retryDelay > 0 && { delayMs: retryDelay }),
            at: Date.now(),
          })
        },
      },
    )
  } catch (err) {
    if (err instanceof RetryAbortError && abortedOriginal !== undefined) throw abortedOriginal
    throw err
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
      return await runCodeStep(step, ctx, events, runtime)
    case 'infer':
      return await runInferStep(step, ctx, backends, events, runtime)
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
  events: EventBus | undefined,
  runtime?: ExecutionRuntime,
): Promise<unknown> {
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
        : ctx.artifacts === undefined
          ? freezeContext({ ...ctx, workspace: preparedWorkspace.handle })
          : freezeContext({
              ...ctx,
              workspace: preparedWorkspace.handle,
              artifacts: bindArtifactWorkspace(ctx.artifacts, preparedWorkspace.handle.path),
            })

    const resolvedPolicy = resolvePermissions(
      runtime?.defaultPermissions,
      applyWorkspacePermissions(step.permissions, preparedWorkspace?.handle.path),
      runtime?.permissionProfiles ?? {},
      { grantUnrestricted: runtime?.unrestrictedGrant === true },
    )
    // Bound a delegated child step to the delegating agent's grant.
    const policy =
      runtime?.delegationCeiling !== undefined
        ? intersectResolvedPolicies(runtime.delegationCeiling, resolvedPolicy)
        : resolvedPolicy
    emitBypassIfUnrestricted(policy, events, ctx.run.runId, step.id)
    const enforcer = new TrustEnforcer(policy)

    // Mirror runAgentStep: enforce canAccessSecret when the author declared a
    // policy or a delegation ceiling is in force. Passing `undefined` here would
    // skip the gate entirely, letting the step read any declared secret and a
    // delegated child escape its parent's allowedSecrets (a default-deny breach).
    // A top-level step with no declared policy keeps resolving unconditionally.
    const secretPolicy =
      step.permissions !== undefined || runtime?.delegationCeiling !== undefined
        ? policy
        : undefined
    const resolvedSecrets = await resolveDeclaredSecrets(
      step,
      secretPolicy,
      runtime?.secretResolver,
      events,
      ctx.run.runId,
    )
    const secretsAccessor = createSecretsAccessor(resolvedSecrets)

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
        ? setTimeout(
            () => stepController.abort(new StepTimeoutError(step.id, timeoutMs)),
            timeoutMs,
          )
        : undefined

    const exec = createExec(enforcer, stepSignal, {
      ...(events !== undefined && { events }),
      runId: ctx.run.runId,
      stepId: step.id,
    })
    const stepCtx = freezeContext({
      ...workspaceCtx,
      signal: stepSignal,
      ...(secretsAccessor !== undefined && { secrets: secretsAccessor }),
      exec,
    })

    const runFn = await resolveCodeRun(step, runtime?.pipelineBaseDir)
    let result: unknown
    try {
      if (timeoutMs === undefined) {
        result = await runFn(stepCtx)
      } else {
        result = await Promise.race([
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
      }
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      if (onParentAbort !== undefined) ctx.signal.removeEventListener('abort', onParentAbort)
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
  } catch (error) {
    if (!finishedWorkspace) {
      await preparedWorkspace?.finishStep('failed')
    }
    throw error
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

async function runInferStep(
  step: Extract<Step, { kind: 'infer' }>,
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
  // infer() has no `permissions` field, so its only secret ceiling is an active
  // delegation ceiling. Pass it (and the event bus) so a delegated child cannot
  // read secrets outside its parent's allowedSecrets and the access is audited;
  // a top-level infer keeps resolving declared secrets unconditionally.
  const resolvedSecrets = await resolveDeclaredSecrets(
    step,
    runtime?.delegationCeiling,
    runtime?.secretResolver,
    events,
    ctx.run.runId,
  )
  const secretsAccessor = createSecretsAccessor(resolvedSecrets)
  const stepCtx =
    secretsAccessor !== undefined ? freezeContext({ ...ctx, secrets: secretsAccessor }) : ctx
  const promptValue = await resolveValueOrFnAsync(step.prompt, stepCtx)
  const systemText =
    step.system === undefined ? undefined : await resolveValueOrFnAsync(step.system, stepCtx)
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
  const requestedInferBackend = step.backend ?? runtime?.defaultInferBackend
  const candidates = backendCandidates(requestedInferBackend)
  const allowMissingCandidateFallback = Array.isArray(requestedInferBackend)
  const attempted: string[] = []
  let lastUnavailable: BackendUnavailableError | undefined
  let response: import('../backend.js').InferenceResponse | undefined
  const tryBackend = async (backendId: string | undefined): Promise<boolean> => {
    if (backendId !== undefined) attempted.push(backendId)
    const backend = backends.resolveForLlm({ backendId })
    const isMultimodalPrompt = Array.isArray(promptValue)
    if (isMultimodalPrompt && backend.capabilities.vision !== true) {
      throw new BackendCapabilityError(
        `step "${step.id}": backend "${backend.id}" does not support image content (capabilities.vision is not true). Route image prompts to a vision-capable backend (e.g. anthropic, openai).`,
        backend.id,
        'vision' as keyof import('../backend.js').BackendCapabilities,
      )
    }
    try {
      // biome-ignore lint/style/noNonNullAssertion: capability checked in resolveForLlm
      response = await backend.inference!(req, {
        signal: stepCtx.signal,
        ...(onPartial !== undefined && { onPartial }),
      })
      return true
    } catch (err) {
      if (!(err instanceof BackendUnavailableError)) throw err
      lastUnavailable = err
      return false
    }
  }
  if (candidates === undefined) {
    const ok = await tryBackend(undefined)
    if (!ok) {
      throw (
        lastUnavailable ??
        new BackendUnavailableError(`backend for step "${step.id}" is not available`, 'unknown')
      )
    }
  } else {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]
      if (candidate === undefined) continue
      try {
        if (await tryBackend(candidate)) break
      } catch (err) {
        if (err instanceof BackendNotFoundError && allowMissingCandidateFallback) continue
        throw err
      }
      const next = candidates[i + 1]
      if (next !== undefined && lastUnavailable !== undefined) {
        emitBackendFailover(events, {
          runId: ctx.run.runId,
          stepId: step.id,
          kind: 'infer',
          from: candidate,
          to: next,
          error: lastUnavailable,
        })
      }
    }
    if (response === undefined) {
      throw noAvailableBackendError(step.id, 'infer', attempted, lastUnavailable)
    }
  }
  if (response === undefined) {
    throw new BackendNotFoundError('no backend with prompt capability is registered')
  }
  if (step.outputSchema !== undefined) {
    const candidate = response.structured ?? response.text
    return await validate(step.outputSchema, candidate, 'output', {
      stepId: step.id,
      pipelineId: ctx.run.pipelineId,
    })
  }
  return {
    text: response.text ?? '',
    usage: response.usage,
    ...(response.finishReason !== undefined && { finishReason: response.finishReason }),
    ...(response.reasoning !== undefined && { reasoning: response.reasoning }),
  }
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
  // Resolve the backend: an explicit `backend:` on the step wins; otherwise
  // fall back to the runtime's `defaultAgentBackend` (the activated project's
  // `config.backends.agent`); finally fall through to the registry's
  // first-with-run() behavior. Without the runtime fallback, a workflow that
  // omits `backend:` and relies on its project config was at the mercy of
  // registry insertion order across concurrent projects.
  const requestedAgentBackend = step.backend ?? runtime?.defaultAgentBackend
  const candidates = backendCandidates(requestedAgentBackend)
  const allowMissingCandidateFallback = Array.isArray(requestedAgentBackend)
  if (candidates !== undefined && candidates.length === 0) {
    throw noAvailableBackendError(step.id, 'agent', [], undefined)
  }
  const attemptedBackends: string[] = []
  let lastUnavailable: BackendUnavailableError | undefined
  let backend: SkelmBackend | undefined
  let firstResolvedCandidateIndex = 0
  if (candidates === undefined) {
    backend = backends.resolveForAgent({ backendId: undefined })
  } else {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]
      if (candidate === undefined) continue
      attemptedBackends.push(candidate)
      try {
        backend = backends.resolveForAgent({ backendId: candidate })
        firstResolvedCandidateIndex = i
        break
      } catch (err) {
        if (err instanceof BackendNotFoundError && allowMissingCandidateFallback) continue
        throw err
      }
    }
    if (backend === undefined) {
      throw noAvailableBackendError(step.id, 'agent', attemptedBackends, undefined)
    }
  }
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
        : ctx.artifacts === undefined
          ? freezeContext({ ...ctx, workspace: preparedWorkspace.handle })
          : freezeContext({
              ...ctx,
              workspace: preparedWorkspace.handle,
              artifacts: bindArtifactWorkspace(ctx.artifacts, preparedWorkspace.handle.path),
            })
    // Resolve permissions + secrets FIRST so step.prompt / step.system /
    // step.mcp functions receive ctx.secrets, matching the contract that
    // runCodeStep and runInferStep already implement. Without this ordering
    // agent steps see no secrets in their user-supplied callbacks.
    const declaredPolicy =
      step.permissions !== undefined || step.mcp !== undefined || preparedWorkspace !== undefined
        ? resolvePermissions(
            runtime?.defaultPermissions,
            applyWorkspacePermissions(step.permissions, preparedWorkspace?.handle.path),
            runtime?.permissionProfiles,
            { grantUnrestricted: runtime?.unrestrictedGrant === true },
          )
        : undefined
    // Bound a delegated child agent step to the delegating agent's grant. A
    // child that declares no policy would otherwise fall back to the backend's
    // permissive default and escape the ceiling, so cap it at the ceiling.
    const policy =
      runtime?.delegationCeiling !== undefined
        ? declaredPolicy === undefined
          ? runtime.delegationCeiling
          : intersectResolvedPolicies(runtime.delegationCeiling, declaredPolicy)
        : declaredPolicy
    if (policy !== undefined) emitBypassIfUnrestricted(policy, events, ctx.run.runId, step.id)
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
    const resolvedPromptValue = await resolveValueOrFnAsync(step.prompt, stepCtx)
    const isMultimodalAgentPrompt = Array.isArray(resolvedPromptValue)
    if (isMultimodalAgentPrompt && backend.capabilities.vision !== true) {
      throw new BackendCapabilityError(
        `step "${step.id}": backend "${backend.id}" does not support image content (capabilities.vision is not true). Route image prompts to a vision-capable backend.`,
        backend.id,
        'vision' as keyof import('../backend.js').BackendCapabilities,
      )
    }
    const resolvedSystemText =
      step.system === undefined ? undefined : await resolveValueOrFnAsync(step.system, stepCtx)
    // AGENTS.md/SOUL.md live in a workflow-local directory; resolve the relative
    // spec against the loaded pipeline's base dir (a relative spec on a
    // programmatic pipeline has no base and surfaces an explicit error).
    const loadedAgentDef =
      step.agentDef === undefined
        ? undefined
        : await loadAgentDefinition(step.agentDef, {
            ...(runtime?.pipelineBaseDir !== undefined && {
              agentDefRoot: runtime.pipelineBaseDir,
            }),
          })
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
          throw markPermissionDeniedAudited(new PermissionDeniedError(detail))
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
    // Backend-capability fail-close is about what the AUTHOR asked the backend
    // to enforce — step permissions (+ a workspace's implied fs scope, + named
    // profiles) — NOT the operator's project-default ceiling. Operator defaults
    // are a broad baseline applied to every step/backend; a
    // `toolPermissions: 'unsupported'` backend (e.g. Pi RPC) legitimately can't
    // enforce skelm's tool/exec/fs dimensions and relies on networkEgress + the
    // gateway egress proxy. Failing closed on default-origin dimensions makes
    // such backends unusable on every entry point that applies defaults
    // (POST /runs, triggers) while they work on the others (cli,
    // /pipelines/:id/run) — an inconsistency that broke egress on the
    // default-applying paths. So we re-resolve the policy WITHOUT operator
    // defaults purely to compute the capability-check dimensions; author-declared
    // restrictions on an incapable backend still fail closed here (the author is
    // warned their constraint can't be honoured). The full merged `policy` is
    // still handed to the TrustEnforcer below, so every dimension the backend CAN
    // enforce is still enforced.
    const authorPolicy =
      step.permissions !== undefined || step.mcp !== undefined || preparedWorkspace !== undefined
        ? resolvePermissions(
            undefined,
            applyWorkspacePermissions(step.permissions, preparedWorkspace?.handle.path),
            runtime?.permissionProfiles,
            { grantUnrestricted: runtime?.unrestrictedGrant === true },
          )
        : undefined
    const declaredPermissionDimensions = collectResolvedPermissionDimensions(
      authorPolicy,
      mcpServers,
    )
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
    if (policy?.approval) {
      if (runtime?.approvalGate === undefined) {
        // Default-deny: a step that declares approval gating cannot run
        // when no gate is wired. Silently skipping the check would mean
        // a workflow asking for human approval got none and ran anyway.
        events?.publish({
          type: 'permission.denied',
          runId: ctx.run.runId,
          stepId: step.id,
          dimension: 'tool',
          detail: `step "${step.id}" requires approval (on: ${[...policy.approval.on].join(',') || 'all'}) but no approvalGate is configured on the runtime`,
          at: Date.now(),
        })
        throw new ApprovalDeniedError(step.id, undefined, 'no approval gate configured')
      }
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
      prompt: resolvedPromptValue as string | readonly ContentPart[],
      ...(resolvedSystemText !== undefined && { system: resolvedSystemText }),
      ...(loadedAgentDef !== undefined && {
        agentDef: {
          name: loadedAgentDef.id,
          instructions: loadedAgentDef.instructions,
          ...(loadedAgentDef.soul !== undefined && { soul: loadedAgentDef.soul }),
        },
      }),
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
      // Fail-fast at step start when the resolved policy EXPLICITLY
      // permits any agentmemory op but the chosen backend does not
      // advertise the capability. Silent no-op was the prior failure
      // mode and masked backends that simply forgot to wire the
      // integration — the gateway alone could not catch this because it
      // doesn't know the backend. We check `policy.agentmemory` flags
      // directly so that an operator-granted `unrestricted` bypass
      // (which short-circuits TrustEnforcer.canUseAgentmemory) does NOT
      // trip the gate — bypass means "trust the run", not "this step
      // deliberately opted into agentmemory".
      if (policy !== undefined && backend.capabilities.agentmemory !== true) {
        const am = policy.agentmemory
        const explicitlyGranted =
          am.allowObserve ||
          am.allowSearch ||
          am.allowSession ||
          am.allowContext ||
          am.allowSave ||
          am.allowRecall ||
          am.allowGraph
        if (explicitlyGranted) {
          throw new BackendCapabilityError(
            `backend ${backend.id} does not declare capabilities.agentmemory but the step's resolved policy permits at least one agentmemory op. Either pick a backend that wires the agentmemory handle, or remove the agentmemory grant from the step's permissions.`,
            backend.id,
            'agentmemory',
          )
        }
      }
      const agentmemoryHandle =
        runtime?.agentmemoryHandleFactory !== undefined && policy !== undefined
          ? runtime.agentmemoryHandleFactory({
              runId: ctx.run.runId,
              stepId: step.id,
              canUseAgentmemory: (op) => new TrustEnforcer(policy).canUseAgentmemory(op),
              ...(events !== undefined && { events }),
            })
          : undefined
      // Bind the delegation capability only when the runtime can resolve
      // pipelines and the step has a resolved policy — the policy becomes the
      // child's ceiling. Whether the agent may delegate to a given id is gated
      // by the `delegate` tool via canDelegate; this just supplies the runner.
      const ceiling = policy
      const delegate =
        runtime?.pipelineRegistry !== undefined && ceiling !== undefined
          ? (agentId: string, input: unknown) =>
              runDelegation(
                agentId,
                input,
                { runId: ctx.run.runId, stepId: step.id, signal: stepSignal, ceiling },
                runtime,
                backends,
                events,
              )
          : undefined
      let response: import('../backend.js').AgentResponse | undefined
      const invokeBackend = async (
        candidateBackend: SkelmBackend,
      ): Promise<import('../backend.js').AgentResponse | undefined> => {
        if (isMultimodalAgentPrompt && candidateBackend.capabilities.vision !== true) {
          throw new BackendCapabilityError(
            `step "${step.id}": backend "${candidateBackend.id}" does not support image content (capabilities.vision is not true). Route image prompts to a vision-capable backend.`,
            candidateBackend.id,
            'vision' as keyof import('../backend.js').BackendCapabilities,
          )
        }
        if (
          mcpServers !== undefined &&
          mcpServers.length > 0 &&
          !candidateBackend.capabilities.mcp
        ) {
          const detail = `backend ${candidateBackend.id} does not support per-step MCP attachments`
          events?.publish({
            type: 'permission.denied',
            runId: ctx.run.runId,
            stepId: step.id,
            dimension: 'mcp',
            detail,
            at: Date.now(),
          })
          throw new BackendCapabilityError(detail, candidateBackend.id, 'mcp')
        }
        if (
          authorPolicy !== undefined &&
          mcpServers !== undefined &&
          mcpServers.length > 0 &&
          candidateBackend.capabilities.toolPermissions === 'native'
        ) {
          enforceFilesystemMcpRoots(
            authorPolicy,
            mcpServers,
            events,
            ctx.run.runId,
            step.id,
            `step "${step.id}"`,
          )
        }
        if (
          step.skills !== undefined &&
          step.skills.length > 0 &&
          !candidateBackend.capabilities.skills
        ) {
          const detail = `backend ${candidateBackend.id} does not support skill loading`
          events?.publish({
            type: 'permission.denied',
            runId: ctx.run.runId,
            stepId: step.id,
            dimension: 'skill',
            detail,
            at: Date.now(),
          })
          throw new BackendCapabilityError(detail, candidateBackend.id, 'skills')
        }
        if (policy !== undefined && candidateBackend.capabilities.agentmemory !== true) {
          const am = policy.agentmemory
          const explicitlyGranted =
            am.allowObserve ||
            am.allowSearch ||
            am.allowSession ||
            am.allowContext ||
            am.allowSave ||
            am.allowRecall ||
            am.allowGraph
          if (explicitlyGranted) {
            throw new BackendCapabilityError(
              `backend ${candidateBackend.id} does not declare capabilities.agentmemory but the step's resolved policy permits at least one agentmemory op. Either pick a backend that wires the agentmemory handle, or remove the agentmemory grant from the step's permissions.`,
              candidateBackend.id,
              'agentmemory',
            )
          }
        }
        const mcpHost =
          mcpServers !== undefined &&
          mcpServers.length > 0 &&
          candidateBackend.capabilities.toolPermissions === 'wrapped'
            ? await createMcpHost(mcpServers, {
                ...(policy !== undefined && { enforcer: new TrustEnforcer(policy) }),
                ...(events !== undefined && { events }),
                runId: ctx.run.runId,
                stepId: step.id,
              })
            : undefined
        try {
          // biome-ignore lint/style/noNonNullAssertion: capability checked in resolveForAgent
          return await candidateBackend.run!(req, {
            signal: stepSignal,
            ...(policy !== undefined && { permissions: policy }),
            ...(step.permissions !== undefined && { declaredPermissions: step.permissions }),
            ...(mcpHost !== undefined && { mcpHost }),
            ...(policyFetch !== undefined && { fetch: policyFetch }),
            ...(loadSkill !== undefined && { loadSkill }),
            ...(egressToken !== undefined && { egressToken }),
            ...(proxyEnv !== undefined && { proxyEnv }),
            ...(onPartial !== undefined && { onPartial }),
            ...(agentmemoryHandle !== undefined && { agentmemory: agentmemoryHandle }),
            ...(delegate !== undefined && { delegate }),
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
          if (!(err instanceof BackendUnavailableError)) throw err
          lastUnavailable = err
          return undefined
        } finally {
          await mcpHost?.dispose()
        }
      }
      try {
        if (candidates === undefined) {
          response = await invokeBackend(backend)
          if (response === undefined) {
            throw (
              lastUnavailable ??
              new BackendUnavailableError(`backend ${backend.id} is not available`, backend.id)
            )
          }
        } else {
          for (let i = firstResolvedCandidateIndex; i < candidates.length; i++) {
            const candidate = candidates[i]
            if (candidate === undefined) continue
            if (i > firstResolvedCandidateIndex) {
              attemptedBackends.push(candidate)
              try {
                backend = backends.resolveForAgent({ backendId: candidate })
              } catch (err) {
                if (err instanceof BackendNotFoundError && allowMissingCandidateFallback) continue
                throw err
              }
            }
            response = await invokeBackend(backend)
            if (response !== undefined) break
            const next = candidates[i + 1]
            if (next !== undefined && lastUnavailable !== undefined) {
              emitBackendFailover(events, {
                runId: ctx.run.runId,
                stepId: step.id,
                kind: 'agent',
                from: backend.id,
                to: next,
                error: lastUnavailable,
              })
            }
          }
          if (response === undefined) {
            throw noAvailableBackendError(step.id, 'agent', attemptedBackends, lastUnavailable)
          }
        }
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
        if (onParentAbort !== undefined) ctx.signal.removeEventListener('abort', onParentAbort)
      }
      if (response === undefined) {
        throw noAvailableBackendError(step.id, 'agent', attemptedBackends, lastUnavailable)
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
    if (
      error instanceof PermissionDeniedError &&
      !(error instanceof BackendCapabilityError) &&
      !auditedPermissionDenials.has(error)
    ) {
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

function enforceFilesystemMcpRoots(
  policy: ResolvedPolicy,
  servers: readonly McpServerConfig[],
  events: EventBus | undefined,
  runId: string,
  stepId: StepId,
  label: string,
): void {
  const enforcer = new TrustEnforcer(policy)
  for (const server of servers) {
    if (server.transport !== 'stdio') continue
    for (const root of filesystemMcpRoots(server)) {
      if (enforcer.canRead(root).allow) continue
      const detail = `${label} is not allowed to attach filesystem MCP server "${server.id}" with root "${root}" (not-in-allowlist)`
      events?.publish({
        type: 'permission.denied',
        runId,
        stepId,
        dimension: 'fs.read',
        detail,
        at: Date.now(),
      })
      throw markPermissionDeniedAudited(new PermissionDeniedError(detail))
    }
  }
}

function filesystemMcpRoots(server: Extract<McpServerConfig, { transport: 'stdio' }>): string[] {
  const argv = [server.command, ...(server.args ?? [])]
  const packageIndex = argv.findIndex(
    (arg) =>
      arg === '@modelcontextprotocol/server-filesystem' ||
      arg === 'mcp-server-filesystem' ||
      arg.endsWith('/server-filesystem'),
  )
  if (packageIndex < 0) return []
  return argv.slice(packageIndex + 1).filter((arg) => arg.length > 0 && !arg.startsWith('-'))
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
  const owner = `${ctx.run.runId}:${step.id}`
  const pending: IdempotentCacheEntry = { status: 'pending', owner }
  while (true) {
    const cached = await state.get<IdempotentCacheEntry>(key)
    if (cached !== undefined && 'value' in cached) {
      return cached.value
    }
    if (cached === undefined) {
      const claimed = await state.cas<IdempotentCacheEntry>(key, undefined, pending)
      if (claimed) break
      continue
    }
    await sleep(IDEMPOTENT_PENDING_POLL_MS)
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
      ...(runtime?.unrestrictedGrant !== undefined && {
        unrestrictedGrant: runtime.unrestrictedGrant,
      }),
      currentWorkspace: runtime?.currentWorkspace,
      setCurrentWorkspace: (workspace) => runtime?.setCurrentWorkspace(workspace),
      deferRunWorkspaceFinalizer: (finalizer) => runtime?.deferRunWorkspaceFinalizer(finalizer),
    },
  ).catch(async (err) => {
    const released = await state.cas<IdempotentCacheEntry>(key, pending, { value: undefined })
    if (released) await state.delete(key)
    throw err
  })
  await state.set<IdempotentCacheEntry>(
    key,
    { value },
    { ...(step.ttlMs !== undefined && { ttlMs: step.ttlMs }) },
  )
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
    ...(runtime?.unrestrictedGrant !== undefined && {
      unrestrictedGrant: runtime.unrestrictedGrant,
    }),
    ...(runtime?.workspaceManager !== undefined && { workspaceManager: runtime.workspaceManager }),
    ...(runtime?.skillSource !== undefined && { skillSource: runtime.skillSource }),
    ...(runtime?.secretResolver !== undefined && { secretResolver: runtime.secretResolver }),
    ...(runtime?.pipelineRegistry !== undefined && { pipelineRegistry: runtime.pipelineRegistry }),
    ...(runtime?.delegationCeiling !== undefined && {
      delegationCeiling: runtime.delegationCeiling,
    }),
    ...(runtime?.delegationStack !== undefined && { delegationStack: runtime.delegationStack }),
    ...(runtime?.delegationDepth !== undefined && { delegationDepth: runtime.delegationDepth }),
    ...(runtime?.maxDelegationDepth !== undefined && {
      maxDelegationDepth: runtime.maxDelegationDepth,
    }),
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
    ...(runtime?.unrestrictedGrant !== undefined && {
      unrestrictedGrant: runtime.unrestrictedGrant,
    }),
    ...(runtime?.workspaceManager !== undefined && { workspaceManager: runtime.workspaceManager }),
    ...(runtime?.skillSource !== undefined && { skillSource: runtime.skillSource }),
    ...(runtime?.secretResolver !== undefined && { secretResolver: runtime.secretResolver }),
    ...(runtime?.pipelineRegistry !== undefined && { pipelineRegistry: runtime.pipelineRegistry }),
    ...(runtime?.delegationCeiling !== undefined && {
      delegationCeiling: runtime.delegationCeiling,
    }),
    ...(runtime?.delegationStack !== undefined && { delegationStack: runtime.delegationStack }),
    ...(runtime?.delegationDepth !== undefined && { delegationDepth: runtime.delegationDepth }),
    ...(runtime?.maxDelegationDepth !== undefined && {
      maxDelegationDepth: runtime.maxDelegationDepth,
    }),
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

/** Caller context the runtime binds into a delegating agent's `delegate` callback. */
export interface DelegationCaller {
  readonly runId: string
  readonly stepId: string
  readonly signal: AbortSignal
  /**
   * The delegating agent's resolved policy — becomes the child run's
   * `delegationCeiling`, so the child can never exceed the parent.
   */
  readonly ceiling: ResolvedPolicy
}

/**
 * Run another pipeline (a one-agent pipeline is the "named agent") as a
 * delegated child of the calling agent. Mirrors {@link runInvokeStep}: it
 * resolves the target via the runtime's `pipelineRegistry` and runs it with the
 * same runtime wiring, plus a delegation ceiling, an extended call-stack, and an
 * incremented depth so the child is bounded and runaway chains are refused.
 *
 * Throws {@link DelegationDepthError} / {@link DelegationCycleError} /
 * {@link InvokePipelineNotFoundError} before any child run starts; returns a
 * {@link DelegateResult} once the child reaches a terminal state. Permission
 * enforcement for *whether* the caller may delegate to `agentId` happens in the
 * `delegate` tool via `TrustEnforcer.canDelegate`, before this is invoked.
 */
export async function runDelegation(
  agentId: string,
  input: unknown,
  caller: DelegationCaller,
  runtime: ExecutionRuntime,
  backends: BackendRegistry | undefined,
  events?: EventBus,
): Promise<DelegateResult> {
  // Authoritative permission gate: enforce the caller's `delegation` allowlist
  // here, not only in the native agent's tool. Any backend that calls
  // ctx.delegate routes through this helper, so the allowlist binds regardless
  // of which backend (or tool) initiated the hand-off — defense in depth.
  const decision = new TrustEnforcer(caller.ceiling).canDelegate(agentId)
  if (!decision.allow) {
    events?.publish({
      type: 'permission.denied',
      runId: caller.runId,
      stepId: caller.stepId,
      dimension: 'delegation',
      detail: `delegate denied: ${agentId} — ${decision.reason}`,
      at: Date.now(),
    })
    throw new PermissionDeniedError(`delegation to "${agentId}" denied (${decision.reason})`)
  }
  const stack = runtime.delegationStack ?? []
  const depth = runtime.delegationDepth ?? 0
  const maxDepth = runtime.maxDelegationDepth ?? DEFAULT_MAX_DELEGATION_DEPTH
  if (depth + 1 > maxDepth) {
    throw new DelegationDepthError(agentId, depth + 1, maxDepth)
  }
  if (stack.includes(agentId)) {
    throw new DelegationCycleError(agentId, stack)
  }
  const pipeline = await runtime.pipelineRegistry?.(agentId)
  if (pipeline === undefined) {
    throw new InvokePipelineNotFoundError(agentId, caller.stepId)
  }
  const nestedRun = await runPipeline(pipeline, input, {
    signal: caller.signal,
    ...(events !== undefined && { events }),
    ...(backends !== undefined && { backends }),
    ...(runtime.store !== undefined && { store: runtime.store }),
    ...(runtime.stateStore !== undefined && { stateStore: runtime.stateStore }),
    ...(runtime.defaultPermissions !== undefined && {
      defaultPermissions: runtime.defaultPermissions,
    }),
    ...(runtime.permissionProfiles !== undefined && {
      permissionProfiles: runtime.permissionProfiles,
    }),
    ...(runtime.unrestrictedGrant !== undefined && {
      unrestrictedGrant: runtime.unrestrictedGrant,
    }),
    ...(runtime.workspaceManager !== undefined && { workspaceManager: runtime.workspaceManager }),
    ...(runtime.skillSource !== undefined && { skillSource: runtime.skillSource }),
    ...(runtime.secretResolver !== undefined && { secretResolver: runtime.secretResolver }),
    ...(runtime.pipelineRegistry !== undefined && { pipelineRegistry: runtime.pipelineRegistry }),
    delegationCeiling: caller.ceiling,
    delegationStack: [...stack, agentId],
    delegationDepth: depth + 1,
    maxDelegationDepth: maxDepth,
  })
  if (nestedRun.status === 'completed') {
    return { status: 'completed', runId: nestedRun.runId, output: nestedRun.output }
  }
  if (nestedRun.status === 'cancelled') {
    throw new RunCancelledError(`delegate(${agentId}): child run was cancelled`)
  }
  return {
    status: 'failed',
    runId: nestedRun.runId,
    error: nestedRun.error?.message ?? nestedRun.error?.name ?? 'delegated run did not complete',
  }
}

function bindArtifactWorkspace(
  artifacts: NonNullable<Context['artifacts']>,
  path: string,
): NonNullable<Context['artifacts']> {
  const maybeBindable = artifacts as
    | (typeof artifacts & {
        withWorkspacePath?: (path: string) => NonNullable<Context['artifacts']>
      })
    | undefined
  if (maybeBindable?.withWorkspacePath === undefined) {
    throw new Error('artifact store handle does not support workspace binding')
  }
  return maybeBindable.withWorkspacePath(path)
}
