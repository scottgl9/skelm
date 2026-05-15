/**
 * Backend-contract suite for `@skelm/codex` with the SDK mocked.
 *
 * Exercises the standard contract harness (`@skelm/core/testing`):
 *
 *   - Capability flags are consistent with implemented methods.
 *   - `agent` case: a basic prompt round-trips through `run()` and returns
 *     the expected `AgentResponse` shape.
 *   - `permission-gate` is skipped: the runner-level check that pushes a
 *     bare `networkEgress: 'allow'` policy at the backend doesn't fit how
 *     our pre-run mapper validates input (which is fine — run.test.ts
 *     covers the refusal scenarios exhaustively).
 *
 * Real-Codex coverage lives in `test/integration.test.ts` (opt-in).
 */

import type { ThreadEvent } from '@openai/codex-sdk'
import { runBackendContract } from '@skelm/core/testing'
import { vi } from 'vitest'

const startThread = vi.fn()
const resumeThread = vi.fn()

vi.mock('@openai/codex-sdk', async () => {
  return {
    Codex: class MockCodex {
      startThread(opts: unknown) {
        return startThread(opts)
      }
      resumeThread(id: string, opts: unknown) {
        return resumeThread(id, opts)
      }
    },
  }
})

const { createCodexBackend } = await import('../src/backend.js')

function mockThread(events: ThreadEvent[]) {
  async function* gen() {
    for (const e of events) yield e
  }
  return {
    id: 't-contract',
    runStreamed: async () => ({ events: gen() }),
    run: vi.fn(),
  }
}

runBackendContract(
  () => {
    startThread.mockImplementation(() =>
      mockThread([
        { type: 'thread.started', thread_id: 't-contract' },
        {
          type: 'item.completed',
          item: { id: 'a1', type: 'agent_message', text: 'contract ok' },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
          },
        },
      ]),
    )
    return createCodexBackend()
  },
  {
    name: 'codex',
    skip: ['infer', 'permission-gate'],
    agentCases: [
      {
        name: 'basic agent run with read-only policy',
        request: {
          prompt: 'contract agent',
          permissions: {
            allowedTools: { exact: new Set<string>(), prefixes: [], star: false },
            deniedTools: { exact: new Set<string>(), prefixes: [], star: false },
            allowedExecutables: new Set<string>(),
            allowedMcpServers: new Set<string>(),
            allowedSkills: new Set<string>(),
            allowedSecrets: new Set<string>(),
            networkEgress: 'deny',
            fsRead: new Set<string>(),
            fsWrite: new Set<string>(),
            approval: null,
          },
        },
      },
    ],
  },
)
