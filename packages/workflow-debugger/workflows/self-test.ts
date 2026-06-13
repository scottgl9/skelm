import type { RunEvent } from '@skelm/core'
import { analyzeBundle } from '@skelm/workflow-debugger'
import type {
  ArtifactSummary,
  AuditRow,
  FixProposalTurn,
  RunBundle,
} from '@skelm/workflow-debugger'

// Self-test for @skelm/workflow-debugger: run the analyze loop on a canned
// failed run (no network, no LLM) and assert the report identifies the failing
// step, correlates the denial, carries evidence refs, surfaces a reviewable
// (not applied) fix, and leaks no secret value. Returns a result object;
// throws on any failed assertion.

// Assembled at runtime so no secret-shaped literal lives in source.
const FAKE_TOKEN = ['sk', 'live', '0123456789abcdef'].join('-')

function cannedBundle(): RunBundle {
  const events: RunEvent[] = [
    { type: 'run.created', runId: 'r1', pipelineId: 'demo', input: {}, at: 1, seq: 1 },
    { type: 'step.start', runId: 'r1', stepId: 'fetch', kind: 'agent', at: 2, seq: 2 },
    {
      type: 'permission.denied',
      runId: 'r1',
      stepId: 'fetch',
      dimension: 'network',
      detail: `blocked GET https://api.example.com (Authorization: Bearer ${FAKE_TOKEN})`,
      at: 3,
      seq: 3,
    },
    {
      type: 'step.error',
      runId: 'r1',
      stepId: 'fetch',
      kind: 'agent',
      error: { name: 'PermissionDeniedError', message: `network denied; token ${FAKE_TOKEN}` },
      at: 4,
      seq: 4,
    },
    {
      type: 'run.failed',
      runId: 'r1',
      error: { name: 'PermissionDeniedError', message: 'network denied' },
      at: 5,
      seq: 5,
    },
  ]
  const audit: AuditRow[] = [
    {
      seq: 10,
      runId: 'r1',
      actor: 'gateway',
      action: 'permission.denied',
      data: { dimension: 'network', secret: FAKE_TOKEN },
      at: 3,
    },
  ]
  const artifacts: ArtifactSummary[] = [
    { id: 'a1', name: 'trace.json', mimeType: 'application/json', stepId: 'fetch' },
  ]
  return { runId: 'r1', events, audit, artifacts }
}

const stubTurn: FixProposalTurn = {
  async propose() {
    return {
      remediation: `Add network permission for api.example.com to the fetch step. (token ${FAKE_TOKEN} seen in evidence)`,
      edits: [{ kind: 'setStepField', stepId: 'fetch', field: 'backend', value: 'agent' }],
    }
  },
}

export interface SelfTestResult {
  ok: true
  failingStepId: string
  evidenceCount: number
  permissionDenials: number
}

export async function selfTest(): Promise<SelfTestResult> {
  const bundle = cannedBundle()
  const report = await analyzeBundle(bundle, 'demo', { fixTurn: stubTurn })

  assert(report.failingStep?.stepId === 'fetch', 'failing step should be "fetch"')
  assert(report.correlations.permissionDenials === 1, 'one permission denial correlated')
  assert(report.evidence.length >= 3, 'evidence refs collected')
  assert(
    report.evidence.every((e) => e.ref.length > 0),
    'every evidence carries a ref',
  )
  assert(report.suggestedFix !== undefined, 'a fix is proposed')
  assert(report.suggestedFix?.applied === false, 'fix is not applied')
  assert(report.suggestedFix?.reviewable === true, 'fix is reviewable')

  const serialized = JSON.stringify(report)
  assert(!serialized.includes(FAKE_TOKEN), 'no secret value leaks into the report')

  return {
    ok: true,
    failingStepId: report.failingStep?.stepId ?? '',
    evidenceCount: report.evidence.length,
    permissionDenials: report.correlations.permissionDenials,
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`workflow-debugger self-test failed: ${msg}`)
}

export default selfTest
