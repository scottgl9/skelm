import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  type GitHubPrTriggerCoordinator,
  normalizeGitHubPrEvent,
  registerGitHubPrTrigger,
  verifyGitHubSignature,
} from '../src/github-pr-trigger.js'

function prBody(
  overrides: Partial<{
    action: string
    number: number
    owner: string
    repo: string
    headSha: string
    baseSha: string
    authorLogin: string
    authorType: 'User' | 'Bot'
    labels: string[]
  }> = {},
): unknown {
  const o = {
    action: 'opened',
    number: 42,
    owner: 'octo',
    repo: 'demo',
    headSha: 'aaa',
    baseSha: 'bbb',
    authorLogin: 'alice',
    authorType: 'User' as const,
    labels: [] as string[],
    ...overrides,
  }
  return {
    action: o.action,
    pull_request: {
      number: o.number,
      user: { login: o.authorLogin, type: o.authorType },
      head: { sha: o.headSha },
      base: { sha: o.baseSha, repo: { name: o.repo, owner: { login: o.owner } } },
      labels: o.labels.map((name) => ({ name })),
    },
  }
}

describe('normalizeGitHubPrEvent — payload shaping', () => {
  it('extracts PR fields from a pull_request opened event', () => {
    const got = normalizeGitHubPrEvent('pull_request', prBody({ action: 'opened' }))
    expect(got).not.toBeNull()
    expect(got).toMatchObject({
      kind: 'opened',
      pr: {
        owner: 'octo',
        repo: 'demo',
        number: 42,
        headSha: 'aaa',
        baseSha: 'bbb',
        author: 'alice',
        labels: [],
      },
      authorIsBot: false,
      githubEvent: 'pull_request',
      action: 'opened',
    })
  })

  it('maps pull_request_review submitted → kind=submitted', () => {
    const body = { ...(prBody({ action: 'submitted' }) as object), action: 'submitted' }
    const got = normalizeGitHubPrEvent('pull_request_review', body)
    expect(got?.kind).toBe('submitted')
  })

  it('maps pull_request_review_comment → kind=commented', () => {
    const got = normalizeGitHubPrEvent('pull_request_review_comment', prBody({ action: 'created' }))
    expect(got?.kind).toBe('commented')
  })

  it('maps issue_comment on a PR (with issue.pull_request set) → kind=commented', () => {
    const body = {
      action: 'created',
      issue: {
        number: 7,
        pull_request: { url: '...' },
        user: { login: 'alice', type: 'User' },
        head: { sha: 'aaa' },
        base: { sha: 'bbb', repo: { name: 'demo', owner: { login: 'octo' } } },
        labels: [],
      },
    }
    const got = normalizeGitHubPrEvent('issue_comment', body)
    expect(got?.kind).toBe('commented')
    expect(got?.pr.number).toBe(7)
  })

  it('returns null for issue_comment on a regular issue (no pull_request field)', () => {
    const body = {
      action: 'created',
      issue: { number: 7, user: { login: 'alice', type: 'User' } },
    }
    expect(normalizeGitHubPrEvent('issue_comment', body)).toBeNull()
  })

  it('returns null for unrelated github events', () => {
    expect(normalizeGitHubPrEvent('push', { ref: 'refs/heads/main' })).toBeNull()
    expect(normalizeGitHubPrEvent('release', { action: 'published' })).toBeNull()
  })

  it('marks Bot authors via authorIsBot', () => {
    const got = normalizeGitHubPrEvent(
      'pull_request',
      prBody({ authorLogin: 'dependabot[bot]', authorType: 'Bot' }),
    )
    expect(got?.authorIsBot).toBe(true)
  })
})

describe('normalizeGitHubPrEvent — filters', () => {
  it('filters by events list', () => {
    const opened = normalizeGitHubPrEvent('pull_request', prBody({ action: 'opened' }), {
      events: ['synchronize'],
    })
    expect(opened).toBeNull()
    const sync = normalizeGitHubPrEvent('pull_request', prBody({ action: 'synchronize' }), {
      events: ['synchronize'],
    })
    expect(sync).not.toBeNull()
  })

  it('drops bot authors when filter.dropBotAuthors is true', () => {
    const fromBot = normalizeGitHubPrEvent(
      'pull_request',
      prBody({ authorLogin: 'dependabot[bot]', authorType: 'Bot' }),
      { filter: { dropBotAuthors: true } },
    )
    expect(fromBot).toBeNull()
  })

  it('filters by repo allowlist', () => {
    const got = normalizeGitHubPrEvent('pull_request', prBody({ owner: 'octo', repo: 'demo' }), {
      filter: { repos: ['octo/other'] },
    })
    expect(got).toBeNull()
    const allowed = normalizeGitHubPrEvent(
      'pull_request',
      prBody({ owner: 'octo', repo: 'demo' }),
      { filter: { repos: ['octo/demo'] } },
    )
    expect(allowed).not.toBeNull()
  })
})

describe('verifyGitHubSignature', () => {
  it('accepts a correct sha256 signature and rejects mismatches', () => {
    const secret = 's3cr3t'
    const body = JSON.stringify({ hello: 'world' })
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    expect(verifyGitHubSignature(body, sig, secret)).toBe(true)
    expect(verifyGitHubSignature(body, sig, 'wrong')).toBe(false)
    expect(verifyGitHubSignature(`${body}!`, sig, secret)).toBe(false)
  })

  it('rejects signatures without the sha256= prefix', () => {
    expect(verifyGitHubSignature('x', 'plainhex', 's')).toBe(false)
  })
})

describe('registerGitHubPrTrigger', () => {
  it('registers a webhook trigger with X-GitHub-Delivery dedupe and returns a normalizer', () => {
    const calls: unknown[] = []
    const coord: GitHubPrTriggerCoordinator = {
      register(spec) {
        calls.push(spec)
        return spec
      },
    }
    const helper = registerGitHubPrTrigger(coord, {
      id: 'gh-pr',
      workflowId: 'review-pr',
      path: '/hooks/gh-pr',
      events: ['opened', 'synchronize'],
      filter: { dropBotAuthors: true },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      kind: 'webhook',
      id: 'gh-pr',
      workflowId: 'review-pr',
      path: '/hooks/gh-pr',
      method: 'POST',
      dedupe: { header: 'X-GitHub-Delivery' },
    })

    // normalize() applies the spec's filter to the raw envelope.
    const opened = helper.normalize({
      body: prBody({ action: 'opened' }),
      headers: { 'x-github-event': 'pull_request' },
    })
    expect(opened?.kind).toBe('opened')

    const closed = helper.normalize({
      body: prBody({ action: 'closed' }),
      headers: { 'x-github-event': 'pull_request' },
    })
    expect(closed).toBeNull() // not in events allowlist

    const fromBot = helper.normalize({
      body: prBody({ authorLogin: 'dependabot[bot]', authorType: 'Bot' }),
      headers: { 'x-github-event': 'pull_request' },
    })
    expect(fromBot).toBeNull() // bot author dropped
  })
})
