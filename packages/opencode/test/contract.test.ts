/**
 * Backend-contract suite for `@skelm/opencode`.
 *
 * Runs the capability-self-consistency block from `@skelm/core/testing`.
 * `inference` / `agent` / `permission-gate` are skipped: opencode dispatches
 * through a subprocess, so end-to-end agent runs are exercised by
 * integration tests (`test/backend.test.ts`, `test/client.test.ts`,
 * `test/permission-mapper.test.ts`) rather than the in-process contract
 * harness. The capability block still catches misdeclared capability
 * flags — which was the root motivation for adding the contract gate.
 */

import { resolvePermissions } from '@skelm/core'
import { runBackendContract } from '@skelm/core/testing/contract'
import { createOpencodeBackend } from '../src/backend.js'

runBackendContract(() => createOpencodeBackend({}), {
  name: 'opencode',
  skip: ['inference', 'agent', 'permission-gate'],
  adversarialCases: [
    {
      // Proves opencode's run() denies an mcpServer not in allowedMcpServers
      // BEFORE spawning the opencode subprocess. Empty resolved policy =>
      // every mcp server is denied by default.
      name: 'unallowed mcp server denied at step start',
      dimension: 'mcp',
      request: {
        prompt: 'adversarial mcp',
        permissions: resolvePermissions(undefined, undefined),
        mcpServers: [{ id: 'evil-server', kind: 'stdio', command: 'echo', args: ['hi'] }],
      },
    },
  ],
})
