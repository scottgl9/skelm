import { describe, expect, it } from 'vitest'
import { type PrData, buildReviewPrompt, reviewOutputSchema } from '../src/index.js'
import { DEFAULT_PROFILE, resolveProfile } from '../src/profiles.js'

const pr: PrData = {
  ref: { provider: 'github', owner: 'octo', repo: 'demo', number: 7 },
  title: 'Add retry',
  body: 'desc',
  author: 'dev',
  authorIsBot: false,
  headSha: 'h',
  baseSha: 'b',
  draft: false,
  labels: [],
  changedFiles: [
    { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: 'PATCH_A' },
    { path: 'pnpm-lock.yaml', status: 'modified', additions: 99, deletions: 0, patch: 'LOCK' },
  ],
  commits: [],
  reviews: [],
  checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
}

describe('buildReviewPrompt', () => {
  it('includes the diff, review style, and CI checks', () => {
    const prompt = buildReviewPrompt({
      pr,
      kind: 'first-review',
      profile: DEFAULT_PROFILE,
      priorFindings: [],
    })
    expect(prompt).toContain('octo/demo#7')
    expect(prompt).toContain('first-review')
    expect(prompt).toContain('PATCH_A')
    expect(prompt).toContain('ci: completed/success')
  })

  it('respects ignorePaths', () => {
    const profile = resolveProfile({
      defaultProfile: 'p',
      profiles: [{ id: 'p', ignorePaths: ['pnpm-lock.yaml'] }],
    })
    const prompt = buildReviewPrompt({ pr, kind: 'first-review', profile, priorFindings: [] })
    expect(prompt).not.toContain('LOCK')
    expect(prompt).toContain('PATCH_A')
  })

  it('surfaces prior findings on follow-ups', () => {
    const prompt = buildReviewPrompt({
      pr,
      kind: 'follow-up',
      profile: DEFAULT_PROFILE,
      priorFindings: [{ path: 'src/a.ts', line: 4, severity: 'error', message: 'leak' }],
    })
    expect(prompt).toContain('Prior findings')
    expect(prompt).toContain('src/a.ts:4')
  })
})

describe('reviewOutputSchema', () => {
  it('defaults findings and event', () => {
    const out = reviewOutputSchema.parse({ summary: 's' })
    expect(out.findings).toEqual([])
    expect(out.recommendedEvent).toBe('COMMENT')
  })

  it('rejects an invalid severity', () => {
    expect(() =>
      reviewOutputSchema.parse({
        summary: 's',
        findings: [{ path: 'a', severity: 'nope', message: 'm' }],
      }),
    ).toThrow()
  })
})

describe('resolveProfile', () => {
  it('defaults to a read-only safe-write mode', () => {
    expect(resolveProfile(undefined).safeWrite.mode).toBe('off')
  })
  it('falls back to the built-in default when id is unknown', () => {
    const p = resolveProfile({ defaultProfile: 'x', profiles: [] }, 'missing')
    expect(p.id).toBe('default')
    expect(p.safeWrite.mode).toBe('off')
  })
})
