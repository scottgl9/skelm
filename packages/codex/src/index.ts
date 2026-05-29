/**
 * @skelm/codex — OpenAI Codex backend for skelm via `@openai/codex-sdk`.
 *
 * Codex authenticates via the host `codex` CLI (`codex login`) or
 * `CODEX_API_KEY`. The SDK spawns codex under the hood and exchanges JSONL
 * events; skelm enforces permissions at the boundary and records audit
 * events as Codex emits tool calls, file changes, and shell executions.
 */

export { createCodexBackend } from './backend.js'
export { CodexPermissionError, mapPermissionsToCodex } from './permission-mapper.js'
export type {
  CodexBackendOptions,
  CodexPermissionAuditEntry,
  MappedCodexPolicy,
} from './types.js'
