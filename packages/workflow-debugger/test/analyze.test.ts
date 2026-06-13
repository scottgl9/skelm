import type { RunEvent, WorkflowGraph } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { analyzeBundle, analyzeFailedRun } from '../src/analyze.js'
import type {
  ArtifactSummary,
  AuditRow,
  FixProposalTurn,
  GatewayDebugClient,
  RunBundle,
} from '../src/types.js'

// Assemble secret-shaped literals at runtime (push-protection).
const TOKEN = ['sk', 'test', 'AAAABBBBCCCCDDDD'].join('-')
const BEARER = ['ghp', 'ABCDEF0123456789abcdef'].join('_')

const GRAPH: WorkflowGraph = {
  id: 'demo',
  kind: 'pipeline',
  nodes: [
    { id: 'load', kind: 'code' },
    { id: 'fetch', kind: 'agent', label: 'fetch remote' },
  ],
  edges: [{ from: 'load', to: 'fetch', kind: 'control' }],
}

function failedEvents(): RunEvent[] {
  return [
    { type: 'run.created', runId: 'r1', pipelineId: 'demo', input: {}, at: 1, seq: 1 },
    { type: 'step.start', runId: 'r1', stepId: 'load', kind: 'code', at: 2, seq: 2 },
    {
      type: 'step.complete',
      runId: 'r1',
      stepId: 'load',
      kind: 'code',
      output: {},
      durationMs: 1,
      at: 3,
      seq: 3,
    },
    { type: 'step.start', runId: 'r1', stepId: 'fetch', kind: 'agent', at: 4, seq: 4 },
    {
      type: 'tool.denied',
      runId: 'r1',
      stepId: 'fetch',
      tool: 'http.get',
      reason: 'network-not-allowed',
      at: 5,
      seq: 5,
    },
    {
      type: 'permission.denied',
      runId: 'r1',
      stepId: 'fetch',
      dimension: 'network',
      detail: `blocked api.example.com (Authorization: Bearer ${BEARER})`,
      at: 6,
      seq: 6,
    },
    {
      type: 'step.retry',
      runId: 'r1',
      stepId: 'fetch',
      kind: 'agent',
      attempt: 1,
      error: { name: 'NetworkError', message: 'denied' },
      at: 7,
      seq: 7,
    },
    {
      type: 'tool.result',
      runId: 'r1',
      stepId: 'fetch',
      tool: 'http.get',
      result: { ok: false, error: 'blocked' },
      durationMs: 2,
      at: 8,
      seq: 8,
    },
    {
      type: 'step.error',
      runId: 'r1',
      stepId: 'fetch',
      kind: 'agent',
      error: { name: 'PermissionDeniedError', message: `network denied; token=${TOKEN}` },
      at: 9,
      seq: 9,
    },
    {
      type: 'run.failed',
      runId: 'r1',
      error: { name: 'PermissionDeniedError', message: 'network denied' },
      at: 10,
      seq: 10,
    },
  ]
}

const AUDIT: AuditRow[] = [
  {
    seq: 100,
    runId: 'r1',
    actor: 'gateway',
    action: 'permission.denied',
    data: {
      stepId: 'fetch',
      dimension: 'network',
      detail: `blocked api.example.com (Authorization: Bearer ${BEARER})`,
      token: TOKEN,
    },
    at: 6,
  },
]
const ARTIFACTS: ArtifactSummary[] = [
  { id: 'art-1', name: 'trace.json', mimeType: 'application/json', stepId: 'fetch' },
]

function bundle(overrides: Partial<RunBundle> = {}): RunBundle {
  return {
    runId: 'r1',
    events: failedEvents(),
    audit: AUDIT,
    artifacts: ARTIFACTS,
    graph: GRAPH,
    ...overrides,
  }
}

class FakeGatewayClient implements GatewayDebugClient {
  applyCalls: Array<{ workflowId: string; edits: readonly unknown[] }> = []
  constructor(private readonly b: RunBundle) {}
  async getRun() {
    return { pipelineId: 'demo', status: 'failed' }
  }
  async getEvents() {
    return this.b.events
  }
  async getAudit() {
    return this.b.audit
  }
  async getArtifacts() {
    return this.b.artifacts
  }
  async getWorkflowGraph() {
    return this.b.graph ?? null
  }
  async applyGraphEditsDryRun(workflowId: string, edits: readonly unknown[]) {
    this.applyCalls.push({ workflowId, edits })
    return { ok: true, applied: false as const, dryRun: true as const, diff: '--- a\n+++ b\n' }
  }
}

const stubTurn: FixProposalTurn = {
  async propose(input) {
    return {
      remediation: `Grant network to ${input.failingStep.stepId}. (saw token ${TOKEN})`,
      edits: [
        {
          kind: 'setStepField',
          stepId: input.failingStep.stepId,
          field: 'backend',
          value: 'agent',
        },
      ],
    }
  },
}

describe('analyzeBundle', () => {
  it('identifies the failing step from the first step.error with kind + node', async () => {
    const report = await analyzeBundle(bundle(), 'demo', {})
    expect(report.failingStep?.stepId).toBe('fetch')
    expect(report.failingStep?.kind).toBe('agent')
    expect(report.failingStep?.atSeq).toBe(9)
    expect(report.failingStep?.node?.label).toBe('fetch remote')
  })

  it('falls back to run.failed when no step.error is present', async () => {
    const events = failedEvents().filter((e) => e.type !== 'step.error')
    const report = await analyzeBundle(bundle({ events }), 'demo', {})
    expect(report.failingStep?.stepId).toBe('<run>')
    expect(report.failingStep?.kind).toBe('run')
  })

  it('correlates permission.denied, tool.denied, retries, and tool errors without double-counting audit duplicates', async () => {
    const report = await analyzeBundle(bundle(), 'demo', {})
    expect(report.correlations.permissionDenials).toBe(1)
    expect(report.correlations.toolDenials).toBe(1)
    expect(report.correlations.retries).toBe(1)
    expect(report.correlations.toolErrors).toBe(1)
  })

  it('uses audit rows as evidence and backfills denial correlation when the timeline lacks the denial event', async () => {
    const events = failedEvents().filter(
      (e) => e.type !== 'permission.denied' && e.type !== 'tool.denied',
    )
    const report = await analyzeBundle(bundle({ events }), 'demo', {})
    expect(report.correlations.permissionDenials).toBe(1)
    expect(report.correlations.toolDenials).toBe(0)
    expect(report.evidence.some((e) => e.kind === 'audit' && e.ref === 'audit:100')).toBe(true)
    expect(report.rootCauseHypothesis).toContain('permission/tool denial upstream')
  })

  it('carries evidence refs pointing at events, audit rows, and artifacts', async () => {
    const report = await analyzeBundle(bundle(), 'demo', {})
    expect(report.evidence.length).toBeGreaterThanOrEqual(6)
    expect(report.evidence.every((e) => e.ref.length > 0)).toBe(true)
    expect(report.evidence.some((e) => e.ref === 'event:9')).toBe(true)
    expect(report.evidence.some((e) => e.kind === 'audit' && e.ref === 'audit:100')).toBe(true)
    expect(report.evidence.some((e) => e.kind === 'artifact' && e.ref === 'art-1')).toBe(true)
  })

  it('produces a reviewable, not-applied fix and routes edits through dry-run apply', async () => {
    const client = new FakeGatewayClient(bundle())
    const report = await analyzeBundle(bundle(), 'demo', { fixTurn: stubTurn }, client)
    expect(report.suggestedFix).toBeDefined()
    expect(report.suggestedFix?.applied).toBe(false)
    expect(report.suggestedFix?.reviewable).toBe(true)
    expect(report.suggestedFix?.hasEdit).toBe(true)
    expect(report.suggestedFix?.preview?.dryRun).toBe(true)
    expect(report.suggestedFix?.preview?.applied).toBe(false)
    expect(client.applyCalls).toHaveLength(1)
    expect(client.applyCalls[0]?.workflowId).toBe('demo')
  })

  it('omits the fix when no agent turn is provided (read-only default)', async () => {
    const report = await analyzeBundle(bundle(), 'demo', {})
    expect(report.suggestedFix).toBeUndefined()
  })

  it('redacts every secret value from the report (events, audit, fix prose)', async () => {
    const client = new FakeGatewayClient(bundle())
    const report = await analyzeBundle(bundle(), 'demo', { fixTurn: stubTurn }, client)
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain(BEARER)
    expect(serialized).toContain('[redacted]')
  })
})

describe('analyzeFailedRun', () => {
  it('fetches through the injected client and builds the report', async () => {
    const client = new FakeGatewayClient(bundle())
    const report = await analyzeFailedRun('r1', client, { fixTurn: stubTurn })
    expect(report.runId).toBe('r1')
    expect(report.pipelineId).toBe('demo')
    expect(report.failingStep?.stepId).toBe('fetch')
    expect(JSON.stringify(report)).not.toContain(TOKEN)
  })
})
