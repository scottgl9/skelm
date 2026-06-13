import type { GraphNode, RunEvent, WorkflowGraph } from '@skelm/core'
import { redactString, redactToDetail } from './redact.js'
import type {
  AuditRow,
  DebugReport,
  Evidence,
  FailingStep,
  FixProposalTurn,
  GatewayDebugClient,
  RunBundle,
  SuggestedFix,
} from './types.js'

export interface AnalyzeOptions {
  /**
   * Optional native-agent turn used to draft a remediation. When omitted the
   * report carries no `suggestedFix`; the debugger is read-only and useful with
   * no model attached.
   */
  readonly fixTurn?: FixProposalTurn
}

/**
 * Fetch a failed run's timeline, audit rows, and artifacts through the gateway,
 * then analyze them into a {@link DebugReport}. Read-only: no run is executed
 * and no source is written. Every string in the returned report is redacted.
 */
export async function analyzeFailedRun(
  runId: string,
  client: GatewayDebugClient,
  opts: AnalyzeOptions = {},
): Promise<DebugReport> {
  const run = await client.getRun(runId)
  const events = await client.getEvents(runId)
  const audit = await client.getAudit(runId)
  const artifacts = await client.getArtifacts(runId)

  let graph: WorkflowGraph | undefined
  const pipelineId = run?.pipelineId
  if (pipelineId !== undefined) {
    const g = await client.getWorkflowGraph(pipelineId)
    if (g !== null) graph = g
  }

  const bundle: RunBundle =
    graph !== undefined
      ? { runId, events, audit, artifacts, graph }
      : { runId, events, audit, artifacts }

  return analyzeBundle(bundle, pipelineId, opts, client)
}

/**
 * Analyze a fully-materialized {@link RunBundle}. Separated from the fetch so it
 * can be unit-tested against canned fixtures with no client at all (the client
 * is only needed when a fix turn proposes an edit to preview).
 */
export async function analyzeBundle(
  bundle: RunBundle,
  pipelineId: string | undefined,
  opts: AnalyzeOptions,
  client?: GatewayDebugClient,
): Promise<DebugReport> {
  const evidence: Evidence[] = []
  const failingStep = identifyFailingStep(bundle, evidence)
  const correlations = correlateSignals(bundle, evidence)
  collectArtifactEvidence(bundle, evidence)

  const rootCauseHypothesis = hypothesize(failingStep, correlations)

  const base: Omit<DebugReport, 'suggestedFix'> & {
    pipelineId?: string
    failingStep?: FailingStep
  } = {
    runId: bundle.runId,
    ...(pipelineId !== undefined ? { pipelineId } : {}),
    ...(failingStep !== undefined ? { failingStep } : {}),
    rootCauseHypothesis,
    evidence,
    correlations,
  }

  if (opts.fixTurn === undefined || failingStep === undefined) {
    return base
  }

  const suggestedFix = await proposeFix(
    bundle,
    failingStep,
    evidence,
    rootCauseHypothesis,
    opts.fixTurn,
    pipelineId,
    client,
  )
  return { ...base, suggestedFix }
}

/**
 * The failing step is the first `step.error` in seq order, falling back to the
 * `run.failed` error when no step error was recorded (e.g. a preamble/finalize
 * failure). The step's kind and id come from the event; the graph node, when
 * resolvable, is attached for context.
 */
function identifyFailingStep(bundle: RunBundle, evidence: Evidence[]): FailingStep | undefined {
  const ordered = [...bundle.events].sort(bySeq)

  const stepError = ordered.find((e) => e.type === 'step.error')
  if (stepError !== undefined && stepError.type === 'step.error') {
    const error = redactString(`${stepError.error.name}: ${stepError.error.message}`)
    evidence.push({
      kind: 'step.error',
      ref: refOf(stepError),
      detail: redactString(`step ${stepError.stepId} (${stepError.kind}) errored: ${error}`),
    })
    const node = findNode(bundle.graph, stepError.stepId)
    return {
      stepId: stepError.stepId,
      kind: stepError.kind,
      error,
      ...(stepError.seq !== undefined ? { atSeq: stepError.seq } : {}),
      ...(node !== undefined ? { node } : {}),
    }
  }

  const runFailed = ordered.find((e) => e.type === 'run.failed')
  if (runFailed !== undefined && runFailed.type === 'run.failed') {
    const error = redactString(`${runFailed.error.name}: ${runFailed.error.message}`)
    evidence.push({
      kind: 'run.failed',
      ref: refOf(runFailed),
      detail: redactString(`run failed: ${error}`),
    })
    // No step granularity available; blame is at the run level.
    return {
      stepId: '<run>',
      kind: 'run',
      error,
      ...(runFailed.seq !== undefined ? { atSeq: runFailed.seq } : {}),
    }
  }

  return undefined
}

function correlateSignals(bundle: RunBundle, evidence: Evidence[]): DebugReport['correlations'] {
  let permissionDenials = 0
  let toolDenials = 0
  let toolErrors = 0
  let retries = 0
  const seenPermissionDenials = new Set<string>()
  const seenToolDenials = new Set<string>()

  for (const e of [...bundle.events].sort(bySeq)) {
    switch (e.type) {
      case 'permission.denied': {
        permissionDenials++
        seenPermissionDenials.add(
          signalKey('permission.denied', {
            stepId: e.stepId,
            dimension: e.dimension,
            detail: e.detail,
          }),
        )
        evidence.push({
          kind: 'permission.denied',
          ref: refOf(e),
          detail: redactString(
            `permission denied (${e.dimension}) at step ${e.stepId}: ${e.detail}`,
          ),
        })
        break
      }
      case 'tool.denied': {
        toolDenials++
        seenToolDenials.add(
          signalKey('tool.denied', {
            stepId: e.stepId,
            tool: e.tool,
            reason: e.reason,
          }),
        )
        evidence.push({
          kind: 'tool.denied',
          ref: refOf(e),
          detail: redactString(`tool ${e.tool} denied at step ${e.stepId}: ${e.reason}`),
        })
        break
      }
      case 'step.retry': {
        retries++
        evidence.push({
          kind: 'step.retry',
          ref: refOf(e),
          detail: redactString(
            `step ${e.stepId} retry #${e.attempt}: ${e.error.name}: ${e.error.message}`,
          ),
        })
        break
      }
      case 'tool.result': {
        // A tool result carrying an error-shaped payload is a soft failure the
        // step may have swallowed; surface it as correlated evidence.
        if (isErrorShaped(e.result)) {
          toolErrors++
          evidence.push({
            kind: 'tool.error',
            ref: refOf(e),
            detail: redactString(`tool ${e.tool} returned error: ${redactToDetail(e.result)}`),
          })
        }
        break
      }
      default:
        break
    }
  }

  for (const row of [...bundle.audit].sort(byAuditSeq)) {
    evidence.push({
      kind: 'audit',
      ref: auditRefOf(row),
      detail: describeAuditRow(row),
    })
    const data = asRecord(row.data)
    if (row.action === 'permission.denied') {
      const key = signalKey('permission.denied', {
        stepId: stringField(data, 'stepId'),
        dimension: stringField(data, 'dimension'),
        detail: stringField(data, 'detail'),
      })
      if (!seenPermissionDenials.has(key)) permissionDenials++
    } else if (row.action === 'tool.denied') {
      const key = signalKey('tool.denied', {
        stepId: stringField(data, 'stepId'),
        tool: stringField(data, 'tool'),
        reason: stringField(data, 'reason'),
      })
      if (!seenToolDenials.has(key)) toolDenials++
    }
  }

  return { permissionDenials, toolDenials, toolErrors, retries }
}

function collectArtifactEvidence(bundle: RunBundle, evidence: Evidence[]): void {
  for (const a of bundle.artifacts) {
    evidence.push({
      kind: 'artifact',
      ref: a.id,
      detail: redactString(
        `artifact ${a.name} (${a.mimeType})${a.stepId ? ` from step ${a.stepId}` : ''}`,
      ),
    })
  }
}

function hypothesize(
  failingStep: FailingStep | undefined,
  correlations: DebugReport['correlations'],
): string {
  if (failingStep === undefined) {
    return 'No failing step found in the run timeline; the run did not record a step error or run failure.'
  }
  if (correlations.permissionDenials > 0 || correlations.toolDenials > 0) {
    return redactString(
      `Step ${failingStep.stepId} (${failingStep.kind}) failed with a permission/tool denial upstream — likely a missing declared permission. Error: ${failingStep.error}`,
    )
  }
  if (correlations.toolErrors > 0) {
    return redactString(
      `Step ${failingStep.stepId} (${failingStep.kind}) failed after a tool returned an error result. Error: ${failingStep.error}`,
    )
  }
  if (correlations.retries > 0) {
    return redactString(
      `Step ${failingStep.stepId} (${failingStep.kind}) exhausted retries before failing. Error: ${failingStep.error}`,
    )
  }
  return redactString(
    `Step ${failingStep.stepId} (${failingStep.kind}) failed: ${failingStep.error}`,
  )
}

async function proposeFix(
  bundle: RunBundle,
  failingStep: FailingStep,
  evidence: readonly Evidence[],
  summary: string,
  turn: FixProposalTurn,
  pipelineId: string | undefined,
  client?: GatewayDebugClient,
): Promise<SuggestedFix> {
  const draft = await turn.propose({
    runId: bundle.runId,
    failingStep,
    evidence,
    summary,
    ...(bundle.graph !== undefined ? { graph: bundle.graph } : {}),
  })

  // The draft can carry secret-shaped text if the model echoed evidence back;
  // redact again at this boundary before anything reaches the report.
  const remediation = redactString(draft.remediation)
  const hasEdit = draft.edits !== undefined && draft.edits.length > 0

  if (!hasEdit || client === undefined || pipelineId === undefined) {
    return { remediation, hasEdit, applied: false, reviewable: true }
  }

  // Reviewable only: route any proposed edit through the dry-run-default apply
  // path. The debugger never writes — it surfaces the preview diff for a human.
  const preview = await client.applyGraphEditsDryRun(pipelineId, draft.edits ?? [])
  return { remediation, hasEdit, applied: false, reviewable: true, preview }
}

function findNode(graph: WorkflowGraph | undefined, stepId: string): GraphNode | undefined {
  if (graph === undefined) return undefined
  const stack: GraphNode[] = [...graph.nodes]
  while (stack.length > 0) {
    const n = stack.pop()
    if (n === undefined) continue
    if (n.id === stepId) return n
    if (n.children !== undefined) stack.push(...n.children)
  }
  return undefined
}

function isErrorShaped(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false
  const r = result as Record<string, unknown>
  if ('error' in r && r.error != null) return true
  if (typeof r.ok === 'boolean' && r.ok === false) return true
  if (typeof r.isError === 'boolean' && r.isError === true) return true
  return false
}

function bySeq(a: RunEvent, b: RunEvent): number {
  const sa = a.seq ?? Number.MAX_SAFE_INTEGER
  const sb = b.seq ?? Number.MAX_SAFE_INTEGER
  if (sa !== sb) return sa - sb
  return a.at - b.at
}

function refOf(e: RunEvent): string {
  return e.seq !== undefined ? `event:${e.seq}` : `event:@${e.at}`
}

function auditRefOf(row: AuditRow): string {
  return row.seq !== undefined ? `audit:${row.seq}` : `audit:@${String(row.at ?? '?')}`
}

function byAuditSeq(a: AuditRow, b: AuditRow): number {
  const sa = a.seq ?? Number.MAX_SAFE_INTEGER
  const sb = b.seq ?? Number.MAX_SAFE_INTEGER
  if (sa !== sb) return sa - sb
  return compareAuditAt(a.at, b.at)
}

function compareAuditAt(a: AuditRow['at'], b: AuditRow['at']): number {
  const na = toAuditMillis(a)
  const nb = toAuditMillis(b)
  if (na !== nb) return na - nb
  return 0
}

function toAuditMillis(value: AuditRow['at']): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed
  }
  return Number.MAX_SAFE_INTEGER
}

function describeAuditRow(row: AuditRow): string {
  const data = asRecord(row.data)
  if (row.action === 'permission.denied') {
    const dimension = stringField(data, 'dimension') ?? 'unknown'
    const stepId = stringField(data, 'stepId')
    const detail = stringField(data, 'detail')
    return redactString(
      `audit permission.denied (${dimension})${stepId ? ` at step ${stepId}` : ''}${detail ? `: ${detail}` : ''}`,
    )
  }
  if (row.action === 'tool.denied') {
    const tool = stringField(data, 'tool') ?? 'unknown'
    const stepId = stringField(data, 'stepId')
    const reason = stringField(data, 'reason')
    return redactString(
      `audit tool.denied ${tool}${stepId ? ` at step ${stepId}` : ''}${reason ? `: ${reason}` : ''}`,
    )
  }
  if (row.action === 'tool.result') {
    const tool = stringField(data, 'tool') ?? 'unknown'
    const stepId = stringField(data, 'stepId')
    return redactString(`audit tool.result ${tool}${stepId ? ` at step ${stepId}` : ''}`)
  }
  const stepId = stringField(data, 'stepId')
  return redactString(`audit ${row.action}${stepId ? ` at step ${stepId}` : ''}`)
}

function signalKey(action: string, fields: Record<string, string | undefined>): string {
  const parts = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value ?? ''}`)
  return `${action}|${parts.join('|')}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}
