/**
 * `@skelm/codex` configuration types.
 *
 * The backend wraps OpenAI's official `@openai/codex-sdk`. The SDK spawns
 * the `codex` CLI under the hood and exchanges JSONL events over stdio, so
 * authentication piggybacks on `codex login` (`~/.codex/auth.json`) or the
 * `CODEX_API_KEY` env var.
 */

import type { ApprovalMode, ModelReasoningEffort, SandboxMode } from '@openai/codex-sdk'

export interface CodexBackendOptions {
  /** Backend id. Defaults to 'codex' when only one codex backend is registered. */
  id?: string
  /** Human-readable label for diagnostics. */
  label?: string

  // SDK pass-through

  /** Path to the codex CLI. Default: 'codex' on PATH (the SDK resolves it). */
  codexPathOverride?: string
  /** Override the Codex API base URL (self-hosted / proxied deployments). */
  baseUrl?: string
  /** API key. Overrides the ambient `CODEX_API_KEY` env var. */
  apiKey?: string
  /**
   * Extra env vars passed to the spawned codex process. When set, the SDK
   * does NOT inherit `process.env` — it uses these vars as the full env.
   * Skelm always merges `BackendContext.proxyEnv` into this map at run time.
   */
  env?: Record<string, string>

  // Defaults applied when the step doesn't override

  /** Default model id, e.g. 'gpt-5.2' or 'gpt-5.3-codex'. */
  model?: string
  /** Default reasoning effort. */
  modelReasoningEffort?: ModelReasoningEffort

  // Behavioral

  /**
   * Skip the SDK's "is this a git repo" sanity check. Defaults to `true` for
   * ephemeral skelm workspaces (which usually have no `.git`).
   */
  skipGitRepoCheck?: boolean
  /**
   * Per-step abort timeout. The runtime's own abort signal already drives
   * cancellation; this is a defensive ceiling. Default: 300_000 (5 min).
   */
  timeoutMs?: number
}

/**
 * Resolved Codex SDK options after skelm permissions are applied. Produced
 * by `permission-mapper.ts` and fed into `Codex.startThread()`.
 */
export interface MappedCodexPolicy {
  sandboxMode: SandboxMode
  approvalPolicy: ApprovalMode
  networkAccessEnabled: boolean
  /** Primary working directory (== WorkspaceHandle.path when present). */
  workingDirectory?: string
  /** Extra writable directories beyond `workingDirectory`. */
  additionalDirectories?: string[]
}

export interface CodexPermissionAuditEntry {
  runId: string
  stepId: string
  timestamp: string
  event: 'permission_check'
  details: {
    declaredPermissions: {
      allowedExecutables: string[]
      allowedMcpServers: string[]
      allowedSkills: string[]
      fsRead: string[]
      fsWrite: string[]
      networkEgress: string
    }
    mapped: MappedCodexPolicy
    decision: 'allow' | 'deny'
    deniedItems: string[]
    backend: 'codex'
  }
}
