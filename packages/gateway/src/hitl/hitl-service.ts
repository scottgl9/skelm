import type { AuditWriter, HitlDecision, HitlPending, Run, RunStore } from '@skelm/core'

/** A pending human-in-the-loop gate, materialized from a parked Run. */
export interface PendingHitlGate {
  readonly runId: string
  readonly pipelineId: string
  readonly stepId: string
  readonly since: number
  readonly gate: HitlPending
}

/** The verbs a resolution can take, mapped to a kind-appropriate decision. */
export interface HitlResolution {
  readonly decision:
    | 'approve'
    | 'deny'
    | 'submit-input'
    | 'submit-edit'
    | 'choose'
    | 'retry'
    | 'skip'
    | 'abort'
  readonly actor?: string
  readonly reason?: string
  /** Value for submit-input / submit-edit. */
  readonly value?: unknown
  /** Selected option ids for choose. */
  readonly selected?: readonly string[]
}

export class HitlResolutionError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'HitlResolutionError'
  }
}

/** List every run currently parked at a HITL gate. */
export async function listPendingHitl(store: RunStore): Promise<PendingHitlGate[]> {
  const ids: string[] = []
  for await (const summary of store.listRuns({ status: 'waiting' })) {
    ids.push(summary.runId)
  }
  const pending: PendingHitlGate[] = []
  for (const runId of ids) {
    const run = await store.getRun(runId)
    const gate = run?.waiting?.hitl
    if (run === null || run === undefined || gate === undefined) continue
    pending.push(toPending(run, gate))
  }
  return pending
}

/** Fetch a single pending gate, or null when the run is not parked at one. */
export async function getPendingHitl(
  store: RunStore,
  runId: string,
): Promise<PendingHitlGate | null> {
  const run = await store.getRun(runId)
  const gate = run?.waiting?.hitl
  if (run === null || run === undefined || gate === undefined) return null
  return toPending(run, gate)
}

function toPending(run: Run, gate: HitlPending): PendingHitlGate {
  return {
    runId: run.runId,
    pipelineId: run.pipelineId,
    stepId: run.waiting?.stepId ?? '',
    since: run.waiting?.since ?? run.startedAt,
    gate,
  }
}

/**
 * Build the typed decision a resolution implies, rejecting verbs that don't
 * apply to the pending gate's kind. Default-deny: an unknown or mismatched
 * verb fails the resolution rather than silently approving.
 */
export function buildDecision(gate: HitlPending, res: HitlResolution): HitlDecision {
  const actor = res.actor
  const reason = res.reason
  const base = { ...(actor !== undefined && { actor }), ...(reason !== undefined && { reason }) }
  const reject = (msg: string): never => {
    throw new HitlResolutionError(400, msg)
  }
  switch (gate.kind) {
    case 'approval':
      if (res.decision === 'approve') return { kind: 'approval', approved: true, ...base }
      if (res.decision === 'deny') return { kind: 'approval', approved: false, ...base }
      return reject(`approval gate accepts approve|deny, got ${res.decision}`)
    case 'input':
      if (res.decision !== 'submit-input')
        return reject(`input gate accepts submit-input, got ${res.decision}`)
      return { kind: 'input', value: res.value, ...base }
    case 'edit':
      if (res.decision !== 'submit-edit')
        return reject(`edit gate accepts submit-edit, got ${res.decision}`)
      return { kind: 'edit', value: res.value, ...base }
    case 'validate':
      if (res.decision === 'approve') return { kind: 'validate', accepted: true, ...base }
      if (res.decision === 'deny') return { kind: 'validate', accepted: false, ...base }
      return reject(`validate gate accepts approve|deny, got ${res.decision}`)
    case 'choose': {
      if (res.decision !== 'choose')
        return reject(`choose gate accepts choose, got ${res.decision}`)
      const selected = res.selected ?? []
      const valid = new Set((gate.options ?? []).map((o) => o.id))
      for (const id of selected) {
        if (!valid.has(id)) return reject(`unknown option: ${id}`)
      }
      if (selected.length === 0) return reject('choose requires at least one selection')
      if (gate.multi !== true && selected.length > 1)
        return reject('choose-one gate accepts a single selection')
      return { kind: 'choose', selected, ...base }
    }
    case 'retry-skip-abort':
      if (res.decision === 'retry') return { kind: 'retry-skip-abort', action: 'retry', ...base }
      if (res.decision === 'skip') return { kind: 'retry-skip-abort', action: 'skip', ...base }
      if (res.decision === 'abort') return { kind: 'retry-skip-abort', action: 'abort', ...base }
      return reject(`retry-skip-abort gate accepts retry|skip|abort, got ${res.decision}`)
  }
}

/**
 * The audit shape for a HITL resolution. NEVER includes the submitted value or
 * selected option payloads beyond their ids — those may carry secret material.
 */
export function hitlAuditEvent(
  pending: PendingHitlGate,
  decision: HitlDecision,
): {
  runId: string
  actor: string
  action: string
  details: Readonly<Record<string, unknown>>
} {
  const verb = auditVerb(decision)
  return {
    runId: pending.runId,
    actor: decision.actor ?? 'unknown',
    action: `hitl.${verb}`,
    details: {
      stepId: pending.stepId,
      kind: decision.kind,
      phase: pending.gate.phase,
      ...(pending.gate.required === true && { required: true }),
      ...(pending.gate.deliveryTarget !== undefined && {
        deliveryTarget: pending.gate.deliveryTarget,
      }),
      ...(decision.reason !== undefined && { reason: decision.reason }),
      ...auditOutcome(decision),
    },
  }
}

function auditVerb(decision: HitlDecision): string {
  switch (decision.kind) {
    case 'approval':
      return decision.approved ? 'approved' : 'denied'
    case 'validate':
      return decision.accepted ? 'validated' : 'rejected'
    case 'input':
      return 'input'
    case 'edit':
      return 'edited'
    case 'choose':
      return 'chose'
    case 'retry-skip-abort':
      return decision.action
  }
}

function auditOutcome(decision: HitlDecision): Record<string, unknown> {
  switch (decision.kind) {
    case 'approval':
      return { approved: decision.approved }
    case 'validate':
      return { accepted: decision.accepted }
    case 'choose':
      return { selected: decision.selected }
    case 'retry-skip-abort':
      return { action: decision.action }
    // input/edit values are intentionally NOT audited (may carry secrets).
    case 'input':
    case 'edit':
      return {}
  }
}

/** Write the resolution to the single gateway audit writer, swallowing failures. */
export async function auditHitl(
  writer: AuditWriter,
  pending: PendingHitlGate,
  decision: HitlDecision,
): Promise<void> {
  try {
    await writer.write(hitlAuditEvent(pending, decision))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `[skelm audit] hitl write failed (run=${pending.runId} step=${pending.stepId}): ${detail}\n`,
    )
  }
}
