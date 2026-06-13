/**
 * Package self-test for `@skelm/pr-review-agent`.
 *
 * Runs the review loop against a stub PR with a stubbed provider transport
 * (no network) and a stubbed model (no LLM). Asserts the load-bearing
 * behaviour: data fetched via the adapter, first-vs-follow-up classification,
 * findings carry file/line, posting is read-only by default, and follow-up
 * verification matches prior findings against post-review commits.
 *
 * Exits 0 when every assertion passes, 1 otherwise. Safe to run anywhere; it
 * touches no network, filesystem, or LLM.
 */

import {
  type Finding,
  type PrData,
  type PrRef,
  type PrReviewAdapter,
  PrReviewWriteDeniedError,
  type ReviewDraft,
  type ReviewModel,
  type ReviewModelOutput,
  classifyReview,
  runReview,
  verifyFollowUp,
} from '@skelm/pr-review-agent'

const REF: PrRef = { provider: 'github', owner: 'octo', repo: 'demo', number: 7 }

function stubPr(overrides: Partial<PrData> = {}): PrData {
  return {
    ref: REF,
    title: 'Add retry to fetch',
    body: 'Adds a retry wrapper.',
    author: 'dev',
    authorIsBot: false,
    headSha: 'head1',
    baseSha: 'base1',
    draft: false,
    labels: [],
    changedFiles: [
      {
        path: 'src/fetch.ts',
        status: 'modified',
        additions: 12,
        deletions: 2,
        patch: '@@ -1 +1 @@',
      },
    ],
    commits: [{ sha: 'c1', message: 'add retry', committedAt: '2026-01-01T00:00:00Z' }],
    reviews: [],
    checks: [],
    ...overrides,
  }
}

class StubAdapter implements PrReviewAdapter {
  readonly provider = 'github'
  readonly canWrite: boolean
  fetched = 0
  posted: ReviewDraft | undefined
  #pr: PrData
  constructor(pr: PrData, canWrite: boolean) {
    this.#pr = pr
    this.canWrite = canWrite
  }
  async fetchPrData(_ref: PrRef): Promise<PrData> {
    this.fetched++
    return this.#pr
  }
  async postReview(_ref: PrRef, draft: ReviewDraft): Promise<{ url: string }> {
    if (!this.canWrite) throw new PrReviewWriteDeniedError('postReview')
    this.posted = draft
    return { url: 'https://github.test/r/1' }
  }
}

function stubModel(out: Partial<ReviewModelOutput> = {}): ReviewModel {
  return {
    async review(): Promise<ReviewModelOutput> {
      return {
        summary: 'Looks mostly good.',
        findings: [
          {
            path: 'src/fetch.ts',
            line: 5,
            severity: 'warning',
            message: 'No backoff',
            ruleId: 'no-backoff',
          },
        ],
        recommendedEvent: 'COMMENT',
        ...out,
      }
    },
  }
}

const failures: string[] = []
function check(name: string, cond: boolean): void {
  if (!cond) failures.push(name)
}

async function main(): Promise<void> {
  // 1. First-review classification + read-only-by-default (no profile write).
  {
    const adapter = new StubAdapter(stubPr(), false)
    const res = await runReview({ adapter, model: stubModel(), ref: REF })
    check('fetched via adapter', adapter.fetched === 1)
    check('classified first-review', res.kind === 'first-review')
    check('finding carries file', res.draft.findings[0]?.path === 'src/fetch.ts')
    check('finding carries line', res.draft.findings[0]?.line === 5)
    check('read-only by default: not posted', res.posted === false)
    check('read-only reason', res.postSkippedReason?.includes('read-only') === true)
    check('nothing posted to adapter', adapter.posted === undefined)
  }

  // 2. Follow-up classification + verification against post-review commits.
  {
    const pr = stubPr({
      reviews: [
        {
          id: 1,
          author: 'reviewer',
          state: 'CHANGES_REQUESTED',
          submittedAt: '2025-12-01T00:00:00Z',
        },
      ],
      commits: [{ sha: 'fix1', message: 'address feedback', committedAt: '2025-12-02T00:00:00Z' }],
    })
    check('classified follow-up', classifyReview(pr) === 'follow-up')
    const prior: Finding[] = [
      { path: 'src/fetch.ts', line: 5, severity: 'warning', message: 'No backoff' },
    ]
    const verified = verifyFollowUp(pr, prior)
    check('follow-up addressed by later commit', verified[0]?.addressed === true)
    check('addressing commit recorded', verified[0]?.addressingCommits.includes('fix1') === true)

    const untouched: Finding[] = [{ path: 'src/other.ts', severity: 'error', message: 'unhandled' }]
    check(
      'follow-up not addressed for untouched file',
      verifyFollowUp(pr, untouched)[0]?.addressed === false,
    )
  }

  // 3. Write gated by profile + write grant. With write mode and a writable
  //    adapter, a posting actually happens and is auditable.
  {
    const adapter = new StubAdapter(stubPr(), true)
    let audited = 0
    const res = await runReview({
      adapter,
      model: stubModel({ recommendedEvent: 'REQUEST_CHANGES' }),
      ref: REF,
      profileConfig: {
        defaultProfile: 'strict',
        profiles: [{ id: 'strict', safeWrite: { mode: 'request-changes' } }],
      },
      onAudit: () => {
        audited++
      },
    })
    check('posted when write granted', res.posted === true)
    check('event clamped within ceiling', res.draft.event === 'REQUEST_CHANGES')
    check('write reached adapter', adapter.posted !== undefined)
    check('audit emitted exactly once', audited === 1)
  }

  // 4. No write without write grant even when profile opts in.
  {
    const adapter = new StubAdapter(stubPr(), false)
    const res = await runReview({
      adapter,
      model: stubModel(),
      ref: REF,
      profileConfig: {
        defaultProfile: 'p',
        profiles: [{ id: 'p', safeWrite: { mode: 'comment' } }],
      },
    })
    check('no write without grant', res.posted === false)
    check('grant-missing reason', res.postSkippedReason?.includes('write grant') === true)
  }

  if (failures.length > 0) {
    process.stderr.write(
      `pr-review-agent self-test FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
    )
    process.exitCode = 1
    return
  }
  process.stdout.write('pr-review-agent self-test: ok (all assertions passed)\n')
}

await main()
