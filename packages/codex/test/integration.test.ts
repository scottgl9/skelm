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

import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  // The builder runs codex doing real, multi-turn work with network — the path
  // where codex's model-stream retry surfaces transient "Reconnecting... N/5"
  // `error` events that the backend used to treat as fatal. This exercises that
  // path end-to-end: a sustained run must complete (recovering from any
  // transient reconnect) and actually write files.
  //
  // Mirrors the builder's exact permission shape: a scoped `fsWrite: [<dir>]`
  // (NOT '*') run with `osSandbox: false`, which maps to codex
  // `danger-full-access` — the gateway-as-trust-boundary mode that works where
  // codex's bubblewrap sandbox can't run (no user namespaces).
  it('completes a real coding task with network (builder mode, osSandbox:false)', async () => {
    const work = mkdtempSync(join(tmpdir(), 'skelm-codex-live-'))
    const backend = createCodexBackend({ skipGitRepoCheck: true, osSandbox: false })
    const policy = resolvePermissions(undefined, {
      fsWrite: [work],
      fsRead: [work],
      networkEgress: 'allow',
    })
    const req: AgentRequest = {
      prompt:
        'In the current working directory create two files: `fib.py` with a function `fib(n)` ' +
        'returning the nth Fibonacci number (0-indexed, fib(0)=0, fib(1)=1), and `test_fib.py` ' +
        'with at least three assert statements covering fib(0), fib(1), and fib(10)=55. ' +
        'Then reply with the single word DONE.',
      permissions: policy,
      cwd: work,
      maxTurns: 12,
    }
    const res = await backend.run?.(req, makeContext())
    expect(res.stopReason).toBe('turn.completed')
    const files = readdirSync(work)
    expect(files).toContain('fib.py')
    expect(files).toContain('test_fib.py')
  }, 300_000)
})
