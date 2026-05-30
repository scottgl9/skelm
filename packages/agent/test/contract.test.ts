/**
 * Backend-contract suite for `@skelm/agent`.
 *
 * Runs the capability-self-consistency block from `@skelm/core/testing`.
 * `inference` / `agent` / `permission-gate` are skipped: the live agent loop
 * and OpenAI-compatible HTTP transport are exercised exhaustively in
 * `test/agent-backend.test.ts`, `test/prompt.test.ts`, and the
 * permissions/mcp tests. The capability block here guards against the
 * specific failure the contract gate exists to catch: drift between
 * declared `BackendCapabilities` flags and the methods the backend
 * actually implements.
 */

import { runBackendContract } from '@skelm/core/testing/contract'
import { createSkelmAgentBackend } from '../src/backend.js'

runBackendContract(
  () =>
    createSkelmAgentBackend({
      baseUrl: 'http://127.0.0.1:0',
      apiKey: 'contract-test',
    }),
  {
    name: 'agent',
    skip: ['inference', 'agent', 'permission-gate'],
  },
)
