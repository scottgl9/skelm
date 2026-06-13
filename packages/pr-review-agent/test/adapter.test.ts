import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrRef, ReviewDraft } from '../src/index.js'

// Stub the GitHub transport entirely — no real network. We control what each
// REST path returns and capture the auth the adapter sends.
const calls: Array<{ method: string; path: string; token?: string; body?: unknown }> = []

vi.mock('@skelm/integrations', async () => {
  const actual = await vi.importActual<typeof import('@skelm/integrations')>('@skelm/integrations')
  return {
    ...actual,
    githubFetch: vi.fn(async (req: { auth: { token?: string }; method: string; path: string }) => {
      calls.push({ method: req.method, path: req.path, token: req.auth.token })
      if (req.path.endsWith('/pulls/7')) {
        return {
          title: 't',
          body: 'b',
          draft: false,
          user: { login: 'dev', type: 'User' },
          head: { sha: 'h1' },
          base: { sha: 'b1' },
          labels: [{ name: 'bug' }],
        }
      }
      if (req.path.endsWith('/files?per_page=100&page=1')) {
        return Array.from({ length: 100 }, (_, index) => ({
          filename: index === 0 ? 'a.ts' : `file-${index + 1}.ts`,
          status: 'modified',
          additions: 1,
          deletions: 0,
          patch: '@@',
        }))
      }
      if (req.path.endsWith('/files?per_page=100&page=2')) {
        return [
          { filename: 'tail.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@' },
        ]
      }
      if (req.path.endsWith('/commits?per_page=100&page=1')) {
        return Array.from({ length: 100 }, (_, index) => ({
          sha: `c${index + 1}`,
          commit: {
            message: `m${index + 1}`,
            committer: { date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z` },
          },
        }))
      }
      if (req.path.endsWith('/commits?per_page=100&page=2')) {
        return [
          { sha: 'c101', commit: { message: 'm101', committer: { date: '2026-02-01T00:00:00Z' } } },
        ]
      }
      if (req.path.endsWith('/reviews?per_page=100&page=1')) {
        return Array.from({ length: 100 }, (_, index) => ({
          id: index + 9,
          user: { login: `r${index + 1}` },
          state: index === 0 ? 'COMMENTED' : 'APPROVED',
          submitted_at: `2025-12-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
        }))
      }
      if (req.path.endsWith('/reviews?per_page=100&page=2')) {
        return [
          {
            id: 10,
            user: { login: 'r2' },
            state: 'APPROVED',
            submitted_at: '2025-12-02T00:00:00Z',
          },
        ]
      }
      if (req.path.includes('/check-runs')) {
        return { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] }
      }
      throw new Error(`unexpected path ${req.path}`)
    }),
    postPullRequestReview: vi.fn(async (params: { body?: string }) => {
      calls.push({ method: 'POST', path: '/reviews', body: params.body })
      return { id: 1, htmlUrl: 'https://github.test/r/1' }
    }),
    postIssueComment: vi.fn(async () => ({ id: 1, htmlUrl: 'https://github.test/c/1' })),
  }
})

const { GitHubReviewAdapter, PrReviewWriteDeniedError, redactSecret } = await import(
  '../src/index.js'
)

const REF: PrRef = { provider: 'github', owner: 'octo', repo: 'demo', number: 7 }

// Assemble a secret-shaped literal from fragments at runtime (push-protection).
const TOKEN = ['ghp', 'A'.repeat(36)].join('_')

afterEach(() => {
  calls.length = 0
})

describe('GitHubReviewAdapter fetch', () => {
  it('fetches complete paginated PR data through the transport using the credential ref', async () => {
    const adapter = new GitHubReviewAdapter({ token: TOKEN })
    const data = await adapter.fetchPrData(REF)
    expect(data.title).toBe('t')
    expect(data.changedFiles[0]?.path).toBe('a.ts')
    expect(data.changedFiles).toHaveLength(101)
    expect(data.changedFiles.at(-1)?.path).toBe('tail.ts')
    expect(data.commits).toHaveLength(101)
    expect(data.commits.at(-1)?.sha).toBe('c101')
    expect(data.reviews).toHaveLength(101)
    expect(data.reviews[0]?.state).toBe('COMMENTED')
    expect(data.reviews.at(-1)?.state).toBe('APPROVED')
    expect(data.checks[0]?.conclusion).toBe('success')
    // The token reached the transport (auth by ref), not embedded in the ref.
    expect(calls.every((c) => c.token === TOKEN || c.token === undefined)).toBe(true)
    expect(calls.some((c) => c.path.endsWith('/pulls/7'))).toBe(true)
    expect(calls.some((c) => c.path.endsWith('/files?per_page=100&page=2'))).toBe(true)
    expect(calls.some((c) => c.path.endsWith('/commits?per_page=100&page=2'))).toBe(true)
    expect(calls.some((c) => c.path.endsWith('/reviews?per_page=100&page=2'))).toBe(true)
  })
})

describe('default-deny write gating', () => {
  it('is read-only by default: canWrite false without a write grant', () => {
    expect(new GitHubReviewAdapter({ token: TOKEN }).canWrite).toBe(false)
  })

  it('denies postReview when read-only — no external write', async () => {
    const adapter = new GitHubReviewAdapter({ token: TOKEN })
    const draft: ReviewDraft = { event: 'COMMENT', summary: 's', findings: [] }
    await expect(adapter.postReview(REF, draft)).rejects.toBeInstanceOf(PrReviewWriteDeniedError)
    expect(calls.some((c) => c.path === '/reviews')).toBe(false)
  })

  it('a write grant without a credential still denies', () => {
    expect(new GitHubReviewAdapter({ canWrite: true }).canWrite).toBe(false)
  })

  it('posts only with both write grant and credential', async () => {
    const adapter = new GitHubReviewAdapter({ token: TOKEN, canWrite: true })
    expect(adapter.canWrite).toBe(true)
    const draft: ReviewDraft = {
      event: 'REQUEST_CHANGES',
      summary: 'please fix',
      findings: [{ path: 'a.ts', line: 2, severity: 'error', message: 'bug' }],
    }
    const res = await adapter.postReview(REF, draft)
    expect(res.url).toBe('https://github.test/r/1')
    expect(calls.some((c) => c.path === '/reviews')).toBe(true)
  })
})

describe('credential redaction', () => {
  it('redactSecret scrubs the token value', () => {
    expect(redactSecret(`auth ${TOKEN} done`, TOKEN)).toBe('auth [REDACTED] done')
    expect(redactSecret('no secret', undefined)).toBe('no secret')
  })

  it('a transport error never carries the credential value', async () => {
    const integrations = await import('@skelm/integrations')
    const spy = vi.mocked(integrations.githubFetch)
    spy.mockRejectedValueOnce(
      new integrations.GitHubApiError(401, 'GET', `/pulls/7?token=${TOKEN}`, `bad ${TOKEN}`),
    )
    const adapter = new GitHubReviewAdapter({ token: TOKEN })
    await expect(adapter.fetchPrData(REF)).rejects.toMatchObject({
      message: expect.not.stringContaining(TOKEN),
    })
  })
})
