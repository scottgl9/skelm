/**
 * Runtime execution of human-in-the-loop (HITL) gates.
 *
 * A gate pauses the run DURABLY by reusing the same wait/resume primitive that
 * backs `wait()`: it calls `waitForInput()` (wired to the Runner's
 * `awaitResume` / the gateway's rehydration path) with a `hitl` payload, emits
 * an enriched `run.waiting` event so the `RunWaiting.hitl` snapshot is
 * persisted, and resolves only when a typed `HitlDecision` arrives. This keeps
 * gates restart-survivable with zero new persistence machinery.
 *
 * Security: a *required* gate (author-declared OR policy-injected) cannot be
 * bypassed. If no wait/resume handler is wired, a required gate fails the step
 * (HitlConfigError) rather than silently proceeding. Deny / reject / abort /
 * deny-on-timeout all raise HitlDeniedError; the gated action never runs.
 */
import {
  HitlConfigError,
  HitlDeniedError,
  HitlUnsupportedGatePhaseError,
  WaitTimeoutError,
} from '../errors.js'
import {
  type HitlDecision,
  type HitlGate,
  type HitlPhase,
  type HitlPolicyContext,
  hitlTimeoutAction,
  toHitlPending,
} from '../hitl.js'
import {
  type AgentPermissions,
  type NetworkPolicy,
  type ResolvedPolicy,
  intersectResolvedPolicies,
  resolvePermissions,
} from '../permissions.js'
import { freezeContext } from '../runner-utils.js'
import { validate } from '../schema.js'
import type { Context, Step } from '../types.js'
import type { ExecutionRuntime } from './runtime.js'

/** What `applyBeforeRun` returns: how to run the body (or short-circuit it). */
type BeforeRunOutcome =
  | { readonly proceed: true; readonly ctx: Context }
  | { readonly proceed: false; readonly skip: true }

type WaitFn = (request: {
  runId: string
  pipelineId: string
  stepId: string
  signal: AbortSignal
  message?: string
  timeoutMs?: number
  hitl?: ReturnType<typeof toHitlPending>
}) => Promise<unknown>

interface EventsLike {
  publish(event: unknown): void
}

function assertSupportedGatePhase(step: Step, phase: HitlPhase, gate: HitlGate): void {
  if (phase === 'beforeRun' && gate.kind === 'edit') {
    throw new HitlUnsupportedGatePhaseError(step.id, phase, gate.kind)
  }
  if (phase === 'afterOutput' && (gate.kind === 'input' || gate.kind === 'choose')) {
    throw new HitlUnsupportedGatePhaseError(step.id, phase, gate.kind)
  }
}

function redactedResumeOutput(decision: HitlDecision): HitlDecision | Record<string, unknown> {
  if (decision.kind === 'input' || decision.kind === 'edit') {
    return {
      kind: decision.kind,
      redacted: true,
      ...(decision.actor !== undefined && { actor: decision.actor }),
      ...(decision.reason !== undefined && { reason: decision.reason }),
    }
  }
  return decision
}

/**
 * Resolve the effective gate for a phase. Precedence (security-first): a
 * policy-injected required gate wins over the author/workflow gate, because the
 * trust boundary's requirement must not be weakened by author config. When the
 * policy injects nothing, the step gate wins over the workflow default.
 */
function resolveGate(
  phase: HitlPhase,
  step: Step,
  runtime: ExecutionRuntime,
  ctx: Context,
): { gate: HitlGate; required: boolean } | undefined {
  const authored = step.humanInLoop?.[phase] ?? runtime.pipelineHumanInLoop?.[phase]
  const required = runtime.hitlPolicy?.(buildPolicyContext(phase, step, ctx, runtime))
  if (required !== undefined) return { gate: required, required: true }
  if (authored !== undefined) return { gate: authored, required: false }
  return undefined
}

function buildPolicyContext(
  phase: HitlPhase,
  step: Step,
  ctx: Context,
  runtime: ExecutionRuntime,
): HitlPolicyContext {
  const risk = deriveRisk(step, runtime)
  return {
    runId: ctx.run.runId,
    stepId: step.id,
    stepKind: step.kind,
    phase,
    ...(risk !== undefined && { risk }),
    ...(runtime.hitlEnvironment !== undefined && { environment: runtime.hitlEnvironment }),
  }
}

/**
 * Derive the policy hook's risk signals from the step's RESOLVED permission
 * surface — operator defaults + named profiles + executable-profile expansion +
 * any delegation ceiling — NOT the raw author-declared `step.permissions`.
 *
 * A risky grant frequently comes from the operator's project defaults or a
 * profile rather than the step itself; reading only `step.permissions` would
 * leave `risk` empty for those steps, so a policy that requires a gate for
 * (say) network egress would never fire and the privileged action would proceed
 * UN-gated — a fail-open bypass of the very gate the policy exists to enforce.
 * Resolving here mirrors what the step handler resolves for enforcement (minus
 * the per-run workspace path, which never changes WHETHER a dimension is
 * granted).
 */
function deriveRisk(step: Step, runtime: ExecutionRuntime): HitlPolicyContext['risk'] {
  const resolved = resolveStepPolicy(step, runtime)
  const executables = [...resolved.allowedExecutables]
  const profiles = [...(resolved.executableProfileNames ?? [])]
  const matchesAnyTool =
    resolved.allowedTools.star ||
    resolved.allowedTools.exact.size > 0 ||
    resolved.allowedTools.prefixes.length > 0
  const risk = {
    ...(executables.length > 0 && { allowedExecutables: executables }),
    ...(profiles.length > 0 && { executableProfiles: profiles }),
    ...(networkGranted(resolved.networkEgress) && { networkEgress: true }),
    ...(matchesAnyTool && { toolDispatch: true }),
    ...(resolved.fsWrite.size > 0 && { fsWrite: true }),
    ...(resolved.unrestricted === true && { unrestricted: true }),
  }
  // Preserve the "no signals → absent" shape: a policy that only tests
  // `ctx.risk` presence must not fire for a step that grants nothing risky.
  return Object.keys(risk).length > 0 ? risk : undefined
}

/** True when the resolved egress policy grants any outbound access. */
function networkGranted(policy: NetworkPolicy): boolean {
  if (policy === 'allow') return true
  if (policy === 'deny') return false
  return policy.allowHosts.length > 0
}

/**
 * Resolve the step's effective permission policy the same way the step handler
 * does (defaults → step → profiles → executable-profile expansion), then bound
 * it by any delegation ceiling. Workspace-path binding is intentionally omitted:
 * it scopes fs roots but never flips whether a dimension is granted.
 */
function resolveStepPolicy(step: Step, runtime: ExecutionRuntime): ResolvedPolicy {
  const stepPermissions = (step as { permissions?: AgentPermissions }).permissions
  const resolved = resolvePermissions(
    runtime.defaultPermissions,
    stepPermissions,
    runtime.permissionProfiles ?? {},
    {
      grantUnrestricted: runtime.unrestrictedGrant === true,
      ...(runtime.executableProfiles !== undefined && {
        executableProfiles: runtime.executableProfiles,
      }),
    },
  )
  return runtime.delegationCeiling !== undefined
    ? intersectResolvedPolicies(runtime.delegationCeiling, resolved)
    : resolved
}

/** Pause the run at a gate and return the typed decision. */
async function awaitDecision(
  gate: HitlGate,
  phase: HitlPhase,
  required: boolean,
  step: Step,
  ctx: Context,
  waitForInput: WaitFn | undefined,
  events: EventsLike | undefined,
  presented: unknown,
): Promise<HitlDecision> {
  if (waitForInput === undefined) {
    // Default-deny: a required gate with no resolver MUST NOT proceed.
    if (required) throw new HitlConfigError(step.id)
    // An author-declared gate with no resolver behaves like wait() with no
    // handler — surface the same configuration error so it can't be ignored.
    throw new HitlConfigError(step.id)
  }
  const pending = toHitlPending(gate, phase, presented, required)
  const message = gate.reason
  events?.publish({
    type: 'run.waiting',
    runId: ctx.run.runId,
    stepId: step.id,
    ...(message !== undefined && { message }),
    ...(gate.timeoutMs !== undefined && { timeoutMs: gate.timeoutMs }),
    hitl: pending,
    at: Date.now(),
  })
  let raw: unknown
  try {
    raw = await waitForInput({
      runId: ctx.run.runId,
      pipelineId: ctx.run.pipelineId,
      stepId: step.id,
      signal: ctx.signal,
      ...(message !== undefined && { message }),
      ...(gate.timeoutMs !== undefined && { timeoutMs: gate.timeoutMs }),
      hitl: pending,
    })
  } catch (err) {
    if (err instanceof WaitTimeoutError) {
      return await onTimeout(gate, phase, required, step, ctx, waitForInput, events, presented)
    }
    throw err
  }
  const decision = normalizeDecision(gate, raw)
  events?.publish({
    type: 'run.resumed',
    runId: ctx.run.runId,
    stepId: step.id,
    output: redactedResumeOutput(decision),
    at: Date.now(),
  })
  return decision
}

/** Apply a gate's `onTimeout`. `escalate` re-pauses once with the escalation config. */
async function onTimeout(
  gate: HitlGate,
  phase: HitlPhase,
  required: boolean,
  step: Step,
  ctx: Context,
  waitForInput: WaitFn,
  events: EventsLike | undefined,
  presented: unknown,
): Promise<HitlDecision> {
  const action = hitlTimeoutAction(gate)
  events?.publish({
    type: 'run.warning',
    runId: ctx.run.runId,
    stepId: step.id,
    code: 'hitl.timeout',
    message: `human-in-the-loop ${gate.kind} gate timed out; applying onTimeout=${action}`,
    at: Date.now(),
  })
  switch (action) {
    case 'approve':
      return synthApprove(gate)
    case 'deny':
      return synthDeny(gate)
    case 'fail':
      throw new HitlDeniedError(step.id, gate.kind, 'timeout', 'gate timed out')
    case 'escalate': {
      const esc = gate.escalation
      // Re-pause once under the escalation's assignees / target / timeout. The
      // escalated gate carries a terminal (non-escalate) onTimeout.
      const escalated = {
        ...gate,
        ...(esc?.assignees !== undefined && { assignees: esc.assignees }),
        ...(esc?.deliveryTarget !== undefined && { deliveryTarget: esc.deliveryTarget }),
        ...(esc?.timeoutMs !== undefined && { timeoutMs: esc.timeoutMs }),
        onTimeout: esc?.onTimeout ?? 'fail',
      } as HitlGate
      return awaitDecision(escalated, phase, required, step, ctx, waitForInput, events, presented)
    }
  }
}

function synthApprove(gate: HitlGate): HitlDecision {
  switch (gate.kind) {
    case 'approval':
      return { kind: 'approval', approved: true, actor: 'timeout' }
    case 'validate':
      return { kind: 'validate', accepted: true, actor: 'timeout' }
    case 'retry-skip-abort':
      return { kind: 'retry-skip-abort', action: 'skip', actor: 'timeout' }
    case 'input':
      return { kind: 'input', value: undefined, actor: 'timeout' }
    case 'edit':
      return { kind: 'edit', value: undefined, actor: 'timeout' }
    case 'choose':
      return { kind: 'choose', selected: [], actor: 'timeout' }
  }
}

function synthDeny(gate: HitlGate): HitlDecision {
  switch (gate.kind) {
    case 'approval':
      return { kind: 'approval', approved: false, actor: 'timeout', reason: 'gate timed out' }
    case 'validate':
      return { kind: 'validate', accepted: false, actor: 'timeout', reason: 'gate timed out' }
    case 'retry-skip-abort':
      return {
        kind: 'retry-skip-abort',
        action: 'abort',
        actor: 'timeout',
        reason: 'gate timed out',
      }
    case 'input':
    case 'edit':
    case 'choose':
      // No deny semantics for value gates; deny degrades to fail-equivalent.
      return { kind: 'approval', approved: false, actor: 'timeout', reason: 'gate timed out' }
  }
}

/**
 * Coerce a resume value into a typed decision. A gateway HITL gate returns a
 * `HitlDecision` already; a bare wait/resume returns a raw value, which we
 * interpret per the gate kind so the same plumbing works for in-process tests.
 */
function normalizeDecision(gate: HitlGate, raw: unknown): HitlDecision {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    'kind' in raw &&
    (raw as { kind?: unknown }).kind === gate.kind
  ) {
    return raw as HitlDecision
  }
  switch (gate.kind) {
    case 'approval':
      return { kind: 'approval', approved: raw === true }
    case 'input':
      return { kind: 'input', value: raw }
    case 'edit':
      return { kind: 'edit', value: raw }
    case 'validate':
      return { kind: 'validate', accepted: raw === true }
    case 'choose':
      return {
        kind: 'choose',
        selected: Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [],
      }
    case 'retry-skip-abort':
      return {
        kind: 'retry-skip-abort',
        action: raw === 'retry' || raw === 'skip' || raw === 'abort' ? raw : 'abort',
      }
  }
}

/**
 * Apply a `beforeRun` gate. Approval / validate denials short-circuit with
 * HitlDeniedError. Input / choose decisions are injected into a fresh context
 * the body then runs against.
 */
export async function applyBeforeRun(
  step: Step,
  ctx: Context,
  runtime: ExecutionRuntime | undefined,
  waitForInput: WaitFn | undefined,
  events: EventsLike | undefined,
): Promise<BeforeRunOutcome> {
  if (runtime === undefined) return { proceed: true, ctx }
  const resolved = resolveGate('beforeRun', step, runtime, ctx)
  if (resolved === undefined) return { proceed: true, ctx }
  const { gate, required } = resolved
  assertSupportedGatePhase(step, 'beforeRun', gate)
  const decision = await awaitDecision(
    gate,
    'beforeRun',
    required,
    step,
    ctx,
    waitForInput,
    events,
    undefined,
  )
  switch (decision.kind) {
    case 'approval':
      if (!decision.approved)
        throw new HitlDeniedError(step.id, 'approval', decision.actor, decision.reason)
      return { proceed: true, ctx }
    case 'validate':
      if (!decision.accepted)
        throw new HitlDeniedError(step.id, 'validate', decision.actor, decision.reason)
      return { proceed: true, ctx }
    case 'retry-skip-abort':
      if (decision.action === 'abort')
        throw new HitlDeniedError(step.id, 'retry-skip-abort', decision.actor, decision.reason)
      if (decision.action === 'skip') return { proceed: false, skip: true }
      return { proceed: true, ctx }
    case 'input': {
      let value = decision.value
      if (gate.kind === 'input' && gate.schema !== undefined) {
        value = await validate(gate.schema, value, 'input', {
          stepId: step.id,
          pipelineId: ctx.run.pipelineId,
        })
      }
      const nextCtx = freezeContext({ ...ctx, hitl: { ...ctx.hitl, input: value } })
      return { proceed: true, ctx: nextCtx }
    }
    case 'choose': {
      const nextCtx = freezeContext({
        ...ctx,
        hitl: { ...ctx.hitl, choose: decision.selected },
      })
      return { proceed: true, ctx: nextCtx }
    }
    case 'edit':
      throw new HitlUnsupportedGatePhaseError(step.id, 'beforeRun', decision.kind)
  }
}

/**
 * Apply an `afterOutput` gate to a produced output. Returns the (possibly
 * edited) output the run continues with. `validate` reject either fails the
 * step or signals a retry; `edit` replaces the output; `choose`/`input` record
 * the decision but pass the output through.
 */
export async function applyAfterOutput(
  step: Step,
  ctx: Context,
  output: unknown,
  runtime: ExecutionRuntime | undefined,
  waitForInput: WaitFn | undefined,
  events: EventsLike | undefined,
): Promise<{ output: unknown; retry?: true }> {
  if (runtime === undefined) return { output }
  const resolved = resolveGate('afterOutput', step, runtime, ctx)
  if (resolved === undefined) return { output }
  const { gate, required } = resolved
  assertSupportedGatePhase(step, 'afterOutput', gate)
  const decision = await awaitDecision(
    gate,
    'afterOutput',
    required,
    step,
    ctx,
    waitForInput,
    events,
    output,
  )
  switch (decision.kind) {
    case 'approval':
      if (!decision.approved)
        throw new HitlDeniedError(step.id, 'approval', decision.actor, decision.reason)
      return { output }
    case 'validate':
      if (!decision.accepted) {
        if (gate.kind === 'validate' && gate.onReject === 'retry') return { output, retry: true }
        throw new HitlDeniedError(step.id, 'validate', decision.actor, decision.reason)
      }
      return { output }
    case 'edit': {
      let value = decision.value
      if (gate.kind === 'edit' && gate.schema !== undefined) {
        value = await validate(gate.schema, value, 'output', {
          stepId: step.id,
          pipelineId: ctx.run.pipelineId,
        })
      }
      return { output: value }
    }
    case 'retry-skip-abort':
      if (decision.action === 'abort')
        throw new HitlDeniedError(step.id, 'retry-skip-abort', decision.actor, decision.reason)
      if (decision.action === 'retry') return { output, retry: true }
      return { output }
    case 'input':
    case 'choose':
      throw new HitlUnsupportedGatePhaseError(step.id, 'afterOutput', decision.kind)
  }
}

/** True when a step (or workflow default) might gate at either phase. */
export function stepHasHitl(step: Step, runtime: ExecutionRuntime | undefined): boolean {
  if (runtime === undefined) return false
  if (step.humanInLoop !== undefined) return true
  if (runtime.pipelineHumanInLoop !== undefined) return true
  return runtime.hitlPolicy !== undefined
}

export { hitlTimeoutAction }
