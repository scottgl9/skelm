import { describe, expect, it, vi } from 'vitest'
import {
  type Finding,
  type PrData,
  type PrRef,
  type PrReviewAdapter,
  type ReviewDraft,
  type ReviewModel,
  type ReviewModelOutput,
  clampEvent,
  classifyReview,
  runReview,
  verifyFollowUp,
} from '../src/index.js'
import { resolveProfile } from '../src/profiles.js'

const REF: PrRef = { provider: 'github', owner: 'octo', repo: 'demo', number: 7 }

function pr(overrides: Partial<PrData> = {}): PrData {
  return {
    ref: REF,
    title: 'change',
    body: '',
    author: 'dev',
    authorIsBot: false,
    headSha: 'h1',
    baseSha: 'b1',
    draft: false,
    labels: [],
    changedFiles: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
    commits: [{ sha: 'c1', message: 'm', committedAt: '2026-01-01T00:00:00Z' }],
    reviews: [],
    checks: [],
    ...overrides,
  }
}

class StubAdapter implements PrReviewAdapter {
  readonly provider = 'github'
  fetched: PrRef[] = []
  posted: ReviewDraft | undefined
  constructor(
    private readonly data: PrData,
    readonly canWrite: boolean,
  ) {}
  async fetchPrData(ref: PrRef): Promise<PrData> {
    this.fetched.push(ref)
    return this.data
  }
  async postReview(_ref: PrRef, draft: ReviewDraft): Promise<{ url: string }> {
    this.posted = draft
    return { url: 'https://x/1' }
  }
}

function model(out: Partial<ReviewModelOutput> = {}): ReviewModel {
  return {
    review: vi.fn(
      async (): Promise<ReviewModelOutput> => ({
        summary: 's',
        findings: [{ path: 'a.ts', line: 3, severity: 'warning', message: 'm' }],
        recommendedEvent: 'COMMENT',
        ...out,
      }),
    ),
  }
}

describe('classifyReview', () => {
  it('is first-review with no submitted reviews', () => {
    expect(classifyReview(pr())).toBe('first-review')
  })
  it('is follow-up once a substantive review was submitted', () => {
    const data = pr({
      reviews: [
        { id: 1, author: 'r', state: 'CHANGES_REQUESTED', submittedAt: '2025-12-01T00:00:00Z' },
      ],
    })
    expect(classifyReview(data)).toBe('follow-up')
  })
  it('ignores pending reviews', () => {
    const data = pr({ reviews: [{ id: 1, author: 'r', state: 'PENDING' }] })
    expect(classifyReview(data)).toBe('first-review')
  })
})

describe('verifyFollowUp', () => {
  const prior: Finding[] = [
    { path: 'a.ts', line: 3, severity: 'warning', message: 'm', ruleId: 'r1' },
  ]

  it('marks a finding addressed when a post-review commit touched its file', () => {
    const data = pr({
      reviews: [{ id: 1, author: 'r', state: 'COMMENTED', submittedAt: '2025-12-01T00:00:00Z' }],
      commits: [{ sha: 'fix', message: 'x', committedAt: '2025-12-02T00:00:00Z' }],
    })
    const v = verifyFollowUp(data, prior)
    expect(v[0]?.addressed).toBe(true)
    expect(v[0]?.addressingCommits).toContain('fix')
    expect(v[0]?.finding.ruleId).toBe('r1')
  })

  it('does not mark addressed when no commit followed the review', () => {
    const data = pr({
      reviews: [{ id: 1, author: 'r', state: 'COMMENTED', submittedAt: '2026-12-01T00:00:00Z' }],
      commits: [{ sha: 'old', message: 'x', committedAt: '2025-01-01T00:00:00Z' }],
    })
    expect(verifyFollowUp(data, prior)[0]?.addressed).toBe(false)
  })

  it('does not mark addressed when the file was not changed', () => {
    const data = pr({
      changedFiles: [{ path: 'other.ts', status: 'added', additions: 1, deletions: 0 }],
    })
    expect(verifyFollowUp(data, prior)[0]?.addressed).toBe(false)
  })
})

describe('clampEvent', () => {
  it('off and comment never approve', () => {
    expect(clampEvent('APPROVE', resolveProfile(undefined), pr())).toBe('COMMENT')
  })
  it('request-changes ceiling downgrades APPROVE to COMMENT', () => {
    const profile = resolveProfile({
      defaultProfile: 'p',
      profiles: [{ id: 'p', safeWrite: { mode: 'request-changes' } }],
    })
    expect(clampEvent('APPROVE', profile, pr())).toBe('COMMENT')
    expect(clampEvent('REQUEST_CHANGES', profile, pr())).toBe('REQUEST_CHANGES')
  })
  it('approve ceiling refuses APPROVE over red required checks', () => {
    const profile = resolveProfile({
      defaultProfile: 'p',
      profiles: [{ id: 'p', safeWrite: { mode: 'approve' }, requiredChecks: ['ci'] }],
    })
    const red = pr({ checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] })
    const green = pr({ checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
    expect(clampEvent('APPROVE', profile, red)).toBe('COMMENT')
    expect(clampEvent('APPROVE', profile, green)).toBe('APPROVE')
  })
})

describe('runReview', () => {
  it('fetches via the adapter and returns findings with file/line', async () => {
    const adapter = new StubAdapter(pr(), false)
    const res = await runReview({ adapter, model: model(), ref: REF })
    expect(adapter.fetched).toEqual([REF])
    expect(res.draft.findings[0]?.path).toBe('a.ts')
    expect(res.draft.findings[0]?.line).toBe(3)
  })

  it('is read-only by default: never posts without a profile write mode', async () => {
    const adapter = new StubAdapter(pr(), true)
    const res = await runReview({ adapter, model: model(), ref: REF })
    expect(res.posted).toBe(false)
    expect(res.postSkippedReason).toContain('read-only')
    expect(adapter.posted).toBeUndefined()
  })

  it('posts and audits once when profile + write grant allow', async () => {
    const adapter = new StubAdapter(pr(), true)
    const onAudit = vi.fn()
    const res = await runReview({
      adapter,
      model: model({ recommendedEvent: 'REQUEST_CHANGES' }),
      ref: REF,
      profileConfig: {
        defaultProfile: 'p',
        profiles: [{ id: 'p', safeWrite: { mode: 'request-changes' } }],
      },
      onAudit,
    })
    expect(res.posted).toBe(true)
    expect(res.postedUrl).toBe('https://x/1')
    expect(adapter.posted?.event).toBe('REQUEST_CHANGES')
    expect(onAudit).toHaveBeenCalledTimes(1)
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'pr-review.post', event: 'REQUEST_CHANGES' }),
    )
  })

  it('performs follow-up verification on a follow-up PR', async () => {
    const data = pr({
      reviews: [
        { id: 1, author: 'r', state: 'CHANGES_REQUESTED', submittedAt: '2025-12-01T00:00:00Z' },
      ],
      commits: [{ sha: 'fix', message: 'x', committedAt: '2025-12-02T00:00:00Z' }],
    })
    const adapter = new StubAdapter(data, false)
    const res = await runReview({
      adapter,
      model: model(),
      ref: REF,
      priorFindings: [{ path: 'a.ts', line: 3, severity: 'warning', message: 'm' }],
    })
    expect(res.kind).toBe('follow-up')
    expect(res.followUp[0]?.addressed).toBe(true)
  })
})
