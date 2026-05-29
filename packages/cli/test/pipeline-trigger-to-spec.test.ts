import { pipelineTriggerToSpec } from '@skelm/gateway'
import { describe, expect, it } from 'vitest'

describe('pipelineTriggerToSpec', () => {
  it('forwards `dedupe` for webhook triggers (Issue #150)', () => {
    const spec = pipelineTriggerToSpec(
      'wf',
      {
        kind: 'webhook',
        path: '/hooks/x',
        secret: 'shh',
        dedupe: { header: 'X-Delivery-Id', ttlMs: 60_000 },
      },
      0,
    )
    expect(spec).toEqual({
      kind: 'webhook',
      id: 'wf#webhook',
      workflowId: 'wf',
      path: '/hooks/x',
      secret: 'shh',
      dedupe: { header: 'X-Delivery-Id', ttlMs: 60_000 },
    })
  })

  it('omits `dedupe` when the trigger does not declare it (no regression for old fixtures)', () => {
    const spec = pipelineTriggerToSpec(
      'wf',
      { kind: 'webhook', path: '/hooks/x', secret: 'shh' },
      0,
    )
    expect(spec).not.toHaveProperty('dedupe')
  })

  it('translates `github-pr` into a webhook with GitHub-Delivery dedupe (Issue #151)', () => {
    const spec = pipelineTriggerToSpec(
      'wf',
      {
        kind: 'github-pr',
        path: '/hooks/gh',
        secret: 'gh-secret',
        events: ['opened', 'synchronize'],
        filter: { dropBotAuthors: true, repos: ['owner/repo'] },
      },
      0,
    )
    expect(spec).toEqual({
      kind: 'webhook',
      id: 'wf#github-pr',
      workflowId: 'wf',
      path: '/hooks/gh',
      method: 'POST',
      secret: 'gh-secret',
      dedupe: { header: 'X-GitHub-Delivery', ttlMs: 24 * 60 * 60 * 1000 },
    })
  })

  it('honors `dedupeTtlMs` override on a github-pr trigger', () => {
    const spec = pipelineTriggerToSpec(
      'wf',
      { kind: 'github-pr', path: '/hooks/gh', dedupeTtlMs: 3_600_000 },
      0,
    )
    expect(spec).toMatchObject({
      kind: 'webhook',
      dedupe: { header: 'X-GitHub-Delivery', ttlMs: 3_600_000 },
    })
  })

  it('returns undefined for unrecognized trigger kinds', () => {
    expect(pipelineTriggerToSpec('wf', { kind: 'no-such-kind', path: '/x' }, 0)).toBeUndefined()
  })
})
