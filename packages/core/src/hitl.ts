/**
 * Human-in-the-loop (HITL) gate primitives.
 *
 * A HITL gate is a durable pause point that suspends a run awaiting a human
 * decision. Gates are authored on steps via the `humanInLoop` field (and a
 * workflow-level default) and are lowered onto the same durable wait/resume
 * machinery that backs `wait()` — see `runner.ts` (`awaitResume`/`resume`) and
 * the gateway `resumeWaitingRun` rehydration path. The pending-gate snapshot is
 * persisted on the Run record (`RunWaiting.hitl`) so a gate survives gateway
 * restart and stays resolvable.
 *
 * Security: a gate that is *required* (declared by the author or injected by a
 * policy hook) cannot be bypassed — the gated action does not proceed until the
 * gate is resolved with a typed decision. Resolution is audited through the
 * single gateway audit writer; never log option values or decision payloads
 * that may carry secrets verbatim beyond what the gate context already exposes.
 */

/** Behaviour when a gate's `timeoutMs` elapses with no human decision. */
export type HitlTimeoutAction = 'fail' | 'approve' | 'deny' | 'escalate'

/** A selectable option presented by a `choose` gate. */
export interface HitlOption {
  /** Stable id returned in the decision. */
  readonly id: string
  /** Human-facing label. */
  readonly label?: string
  /** Optional free-form payload carried with the option. */
  readonly value?: unknown
}

/** Escalation target applied when `onTimeout: 'escalate'` fires. */
export interface HitlEscalation {
  /** Reassign the pending gate to these approvers/assignees. */
  readonly assignees?: readonly string[]
  /** Delivery target for the escalation notification (channel id, email, …). */
  readonly deliveryTarget?: string
  /** Optional secondary timeout (ms) applied after escalation. */
  readonly timeoutMs?: number
  /** Terminal action if the escalated gate also times out. Default: 'fail'. */
  readonly onTimeout?: Exclude<HitlTimeoutAction, 'escalate'>
}

/** Fields common to every gate kind. */
export interface HitlGateBase {
  /** Human-facing reason shown to the approver. */
  readonly reason?: string
  /** Who may resolve this gate (advisory; enforcement is RBAC's job). */
  readonly approvers?: readonly string[]
  /** Alias for `approvers` for input/edit/validate phrasing. */
  readonly assignees?: readonly string[]
  /** Max wall-clock wait before `onTimeout` fires. Omitted = wait indefinitely. */
  readonly timeoutMs?: number
  /** Action taken when `timeoutMs` elapses. Default: 'fail'. */
  readonly onTimeout?: HitlTimeoutAction
  /** Escalation config consulted when `onTimeout: 'escalate'`. */
  readonly escalation?: HitlEscalation
  /** Where to deliver the request notification (channel id, email, webhook ref). */
  readonly deliveryTarget?: string
}

/** Approve / deny — reuses the approval gate semantics. */
export interface HitlApprovalGate extends HitlGateBase {
  readonly kind: 'approval'
}

/** Collect typed input from a human; the value is injected into context. */
export interface HitlInputGate extends HitlGateBase {
  readonly kind: 'input'
  /** Schema the submitted input is validated against before injection. */
  readonly schema?: import('./schema.js').SkelmSchema<unknown>
}

/** Present produced output; the human edits it and the edited value continues. */
export interface HitlEditGate extends HitlGateBase {
  readonly kind: 'edit'
  /** Schema the edited value is validated against before it replaces output. */
  readonly schema?: import('./schema.js').SkelmSchema<unknown>
}

/** Human validates output; reject either fails the step or retries it. */
export interface HitlValidateGate extends HitlGateBase {
  readonly kind: 'validate'
  /** What a reject does. Default: 'fail'. */
  readonly onReject?: 'fail' | 'retry'
}

/** Choose one or many from a fixed option set. */
export interface HitlChooseGate extends HitlGateBase {
  readonly kind: 'choose'
  readonly options: readonly HitlOption[]
  /** Allow selecting more than one option. Default: false (choose-one). */
  readonly multi?: boolean
}

/** On a step failure, the human picks retry | skip | abort. */
export interface HitlRetrySkipAbortGate extends HitlGateBase {
  readonly kind: 'retry-skip-abort'
}

/** Typed union of all HITL gate kinds. */
export type HitlGate =
  | HitlApprovalGate
  | HitlInputGate
  | HitlEditGate
  | HitlValidateGate
  | HitlChooseGate
  | HitlRetrySkipAbortGate

/** The gate kind discriminator. */
export type HitlGateKind = HitlGate['kind']

/**
 * Gates authored on a step (and the workflow-level default). `beforeRun` fires
 * before the step body executes; `afterOutput` fires after the body produces
 * its output, with the output available to the gate (and, for `edit`/`validate`,
 * acting on it).
 */
export interface HumanInLoop {
  readonly beforeRun?: HitlGate
  readonly afterOutput?: HitlGate
}

/** Which phase of step execution a gate fires at. */
export type HitlPhase = 'beforeRun' | 'afterOutput'

/**
 * A typed decision resolving a pending gate. The `kind` matches the gate it
 * resolves; the runtime applies it to control flow or context.
 */
export type HitlDecision =
  | {
      readonly kind: 'approval'
      readonly approved: boolean
      readonly actor?: string
      readonly reason?: string
    }
  | {
      readonly kind: 'input'
      readonly value: unknown
      readonly actor?: string
      readonly reason?: string
    }
  | {
      readonly kind: 'edit'
      readonly value: unknown
      readonly actor?: string
      readonly reason?: string
    }
  | {
      readonly kind: 'validate'
      readonly accepted: boolean
      readonly actor?: string
      readonly reason?: string
    }
  | {
      readonly kind: 'choose'
      readonly selected: readonly string[]
      readonly actor?: string
      readonly reason?: string
    }
  | {
      readonly kind: 'retry-skip-abort'
      readonly action: 'retry' | 'skip' | 'abort'
      readonly actor?: string
      readonly reason?: string
    }

/**
 * Serializable description of a pending gate, persisted on `RunWaiting.hitl`
 * and surfaced by the gateway list/get API. Carries no resolver — resolution
 * requires the running (or rehydrated) gateway. Mirrors the JSON-safe subset of
 * the gate definition.
 */
export interface HitlPending {
  readonly kind: HitlGateKind
  readonly phase: HitlPhase
  readonly reason?: string
  readonly approvers?: readonly string[]
  readonly options?: readonly HitlOption[]
  readonly multi?: boolean
  readonly onTimeout?: HitlTimeoutAction
  readonly deliveryTarget?: string
  /** Whether this gate was injected by a policy hook (cannot be bypassed). */
  readonly required?: boolean
  /** Output presented to the human for `edit`/`validate`/`afterOutput` gates. */
  readonly presented?: unknown
}

/**
 * Context handed to a policy-required-HITL hook. The hook inspects the step
 * and its resolved risk signals and may REQUIRE a gate the author did not
 * declare — e.g. a risky tool, broad executable profile, network egress,
 * package install, production environment, external write, or budget overrun.
 * A gate returned here cannot be bypassed: the gated action does not proceed
 * until it is resolved.
 */
export interface HitlPolicyContext {
  readonly runId: string
  readonly stepId: string
  readonly stepKind: string
  readonly phase: HitlPhase
  /** Resolved permission risk signals, when available for this step. */
  readonly risk?: {
    readonly allowedExecutables?: readonly string[]
    readonly executableProfiles?: readonly string[]
    readonly networkEgress?: boolean
    readonly toolDispatch?: boolean
    readonly fsWrite?: boolean
    readonly unrestricted?: boolean
  }
  /** Operator environment label (e.g. 'production'), when configured. */
  readonly environment?: string
}

/**
 * Hook that may inject a REQUIRED gate for a risky condition. Returning a gate
 * forces a human decision before the action proceeds; returning undefined
 * leaves the author-declared gate (if any) in effect. Supplied only by the
 * trust boundary (gateway config), never by workflow authors.
 */
export type HitlPolicy = (ctx: HitlPolicyContext) => HitlGate | undefined

/** Effective timeout action for a gate; defaults to 'fail'. */
export function hitlTimeoutAction(gate: HitlGate): HitlTimeoutAction {
  return gate.onTimeout ?? 'fail'
}

/** Build the serializable pending snapshot from a gate + phase. */
export function toHitlPending(
  gate: HitlGate,
  phase: HitlPhase,
  presented: unknown,
  required: boolean,
): HitlPending {
  const approvers = gate.approvers ?? gate.assignees
  return {
    kind: gate.kind,
    phase,
    ...(gate.reason !== undefined && { reason: gate.reason }),
    ...(approvers !== undefined && { approvers }),
    ...(gate.kind === 'choose' && { options: gate.options, multi: gate.multi === true }),
    onTimeout: hitlTimeoutAction(gate),
    ...(gate.deliveryTarget !== undefined && { deliveryTarget: gate.deliveryTarget }),
    ...(required && { required: true }),
    ...(presented !== undefined && { presented }),
  }
}
