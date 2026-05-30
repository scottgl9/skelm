/**
 * Backend-contract suite for `@skelm/pi` (RPC backend).
 *
 * Runs the capability-self-consistency block from `@skelm/core/testing`.
 * `inference` / `agent` / `permission-gate` are skipped: pi RPC mode spawns
 * a `pi --mode rpc` subprocess; agent-loop coverage lives in
 * `test/backend.test.ts` and integration tests. The capability block
 * still catches mis-declared capabilities (e.g. `toolPermissions` flag
 * drifting from what the backend actually enforces).
 *
 * The SDK-mode backend (`createPiSdkBackend`) has its own surface and
 * could grow a sibling `contract.sdk.test.ts` if the SDK path ever
 * diverges in capability shape.
 */

import { runBackendContract } from '@skelm/core/testing/contract'
import { createPiBackend } from '../src/backend.js'

runBackendContract(() => createPiBackend({}), {
  name: 'pi',
  skip: ['inference', 'agent', 'permission-gate'],
})
