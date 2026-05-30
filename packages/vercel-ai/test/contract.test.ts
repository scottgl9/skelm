/**
 * Backend-contract suite for `@skelm/vercel-ai`.
 *
 * Runs the capability-self-consistency block from `@skelm/core/testing`.
 * `inference` / `agent` / `permission-gate` are skipped: the Vercel AI SDK
 * round-trip is exhaustively covered in `test/backend.test.ts`
 * (incl. tool-permission gating via `test/permissions.test.ts`). The
 * capability block here is the cheap, always-on guard against drift
 * between declared capabilities and implemented methods.
 */

import { runBackendContract } from '@skelm/core/testing/contract'
import { MockLanguageModelV3 } from 'ai/test'
import { createVercelAiBackend } from '../src/backend.js'

runBackendContract(
  () =>
    createVercelAiBackend({
      model: new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'contract' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 1 },
            outputTokens: { total: 1 },
            totalTokens: 2,
          },
          warnings: [],
        }),
      }),
    }),
  {
    name: 'vercel-ai',
    skip: ['inference', 'agent', 'permission-gate'],
  },
)
