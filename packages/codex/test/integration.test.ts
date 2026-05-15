/**
 * Live Codex integration tests. Skipped unless `SKELM_CODEX_INTEGRATION=1`.
 *
 * Requires:
 *   - The `codex` CLI installed and on PATH.
 *   - `codex login` already completed (or `CODEX_API_KEY` set).
 *   - Network connectivity to the Codex backend.
 *
 * Run locally:
 *   SKELM_CODEX_INTEGRATION=1 pnpm test packages/codex/test/integration.test.ts
 */

import type { AgentRequest, BackendContext, Skill } from '@skelm/core'
import { resolvePermissions } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { createCodexBackend } from '../src/backend.js'

const ENABLED = process.env.SKELM_CODEX_INTEGRATION === '1'

function makeContext(overrides: Partial<BackendContext> = {}): BackendContext {
  return { signal: new AbortController().signal, ...overrides }
}

const describeLive = ENABLED ? describe : describe.skip

describeLive('@skelm/codex — live Codex integration', () => {
  it('runs a trivial prompt to completion', async () => {
    const backend = createCodexBackend({ skipGitRepoCheck: true })
    const policy = resolvePermissions(undefined, { fsWrite: [], fsRead: [], networkEgress: 'deny' })
    const req: AgentRequest = {
      prompt: 'Reply with the single word "ok" and nothing else.',
      permissions: policy,
      maxTurns: 1,
    }
    const res = await backend.run?.(req, makeContext())
    expect(res.text?.toLowerCase()).toContain('ok')
    expect(res.stopReason).toBe('turn.completed')
  }, 120_000)

  it('respects an injected skill: the agent uses the skill body to answer', async () => {
    const backend = createCodexBackend({ skipGitRepoCheck: true })

    const skill: Skill = {
      id: 'magic-word',
      description: 'How the agent must respond to the user.',
      metadata: {},
      source: '/test/skills/magic-word.md',
      body: [
        '# magic-word skill',
        '',
        'When asked for the "magic word", respond with exactly one word:',
        '',
        '`flibbertigibbet`',
        '',
        'Do not include any other text, punctuation, or commentary.',
      ].join('\n'),
    }

    const loadSkill = async (id: string): Promise<Skill | null> => (id === skill.id ? skill : null)

    const policy = resolvePermissions(undefined, {
      fsWrite: [],
      fsRead: [],
      networkEgress: 'deny',
      allowedSkills: ['magic-word'],
    })

    const req: AgentRequest = {
      prompt: 'What is the magic word?',
      permissions: policy,
      skills: ['magic-word'],
      maxTurns: 1,
    }

    const res = await backend.run?.(req, makeContext({ loadSkill }))
    // The agent should have learned the magic word from the skill body
    // and surfaced it. We assert case-insensitively to tolerate minor
    // capitalization differences.
    expect(res.text?.toLowerCase()).toContain('flibbertigibbet')
  }, 120_000)
})
