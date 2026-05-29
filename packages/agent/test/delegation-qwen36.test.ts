/**
 * End-to-end validation of agent-to-agent delegation against a real local
 * model. A router agent must call the `delegate` tool to reach a specialist
 * pipeline, and the specialist's output must flow back into the router's run.
 * Skipped unless SKELM_QWEN36_URL is set, so `pnpm check` stays green on
 * machines without a local server.
 *
 * To run:
 *   SKELM_QWEN36_URL=http://localhost:8000/v1 SKELM_QWEN36_MODEL=qwen36 \
 *     pnpm exec vitest run packages/agent/test/delegation-qwen36.test.ts
 */

import { BackendRegistry, agent, code, pipeline, runPipeline } from '@skelm/core'
import type { Pipeline } from '@skelm/core'
import { describe, expect, it } from 'vitest'

import { createSkelmAgentBackend } from '../src/index.js'

const baseUrl = process.env.SKELM_QWEN36_URL
const model = process.env.SKELM_QWEN36_MODEL ?? 'qwen36'
const skipUnlessSet = baseUrl === undefined ? describe.skip : describe

const MARKER = 'DELEGATION-OK-5521'

// A deterministic specialist: a one-agent pipeline is the named delegation
// target, but to keep the assertion stable we make the specialist a code step
// that returns a known marker. The router (a real model) must still decide to
// call the `delegate` tool and surface the result.
const specialist = pipeline({
  id: 'marker-specialist',
  steps: [code({ id: 'answer', run: () => ({ marker: MARKER }) })],
})

const registry = (id: string): Pipeline | undefined =>
  id === 'marker-specialist' ? (specialist as Pipeline) : undefined

skipUnlessSet('agent delegation against local qwen36', () => {
  it('routes a task to a specialist via the delegate tool and returns its output', async () => {
    const reg = new BackendRegistry()
    reg.register(
      createSkelmAgentBackend({ id: 'agent', baseUrl: baseUrl ?? '', model, timeoutMs: 120_000 }),
    )

    const router = pipeline({
      id: 'router',
      steps: [
        agent({
          id: 'route',
          backend: 'agent',
          prompt: [
            'You MUST call the `delegate` tool exactly once with these arguments:',
            '{ "agentId": "marker-specialist", "input": {} }',
            'The tool returns a JSON envelope containing an `output.marker` field.',
            'After the tool returns, reply with the exact marker value you received and nothing else.',
          ].join('\n'),
          permissions: {
            allowedTools: ['*'],
            delegation: ['marker-specialist'],
            networkEgress: 'allow',
          },
          maxTurns: 4,
        }),
      ],
    })

    const run = await runPipeline(router, undefined, { backends: reg, pipelineRegistry: registry })
    expect(run.status).toBe('completed')
    const text = (run.output as { text?: string } | undefined)?.text ?? ''
    expect(text).toContain(MARKER)
  }, 180_000)

  it('refuses a target that is not on the delegation allowlist', async () => {
    const reg = new BackendRegistry()
    reg.register(
      createSkelmAgentBackend({ id: 'agent', baseUrl: baseUrl ?? '', model, timeoutMs: 120_000 }),
    )

    let childRan = false
    const guarded = pipeline({
      id: 'guarded-specialist',
      steps: [
        code({
          id: 'answer',
          run: () => {
            childRan = true
            return { marker: MARKER }
          },
        }),
      ],
    })
    const guardedRegistry = (id: string): Pipeline | undefined =>
      id === 'guarded-specialist' ? (guarded as Pipeline) : undefined

    const router = pipeline({
      id: 'router-deny',
      steps: [
        agent({
          id: 'route',
          backend: 'agent',
          prompt: [
            'Call the `delegate` tool once with arguments { "agentId": "guarded-specialist", "input": {} }.',
            'If the tool returns a permission error, reply with the single word DENIED.',
          ].join('\n'),
          // delegation allowlist does NOT include guarded-specialist → default-deny.
          permissions: {
            allowedTools: ['*'],
            delegation: ['something-else'],
            networkEgress: 'allow',
          },
          maxTurns: 4,
        }),
      ],
    })

    const run = await runPipeline(router, undefined, {
      backends: reg,
      pipelineRegistry: guardedRegistry,
    })
    expect(run.status).toBe('completed')
    // The hard guarantee: the denied child never ran, regardless of what the
    // model said in its final turn.
    expect(childRan).toBe(false)
  }, 180_000)
})
