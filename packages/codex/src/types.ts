/**
 * `@skelm/codex` configuration types.
 *
 * The backend wraps OpenAI's official `@openai/codex-sdk`. The SDK spawns
 * the `codex` CLI under the hood and exchanges JSONL events over stdio, so
 * authentication piggybacks on `codex login` (`~/.codex/auth.json`) or the
 * `CODEX_API_KEY` env var.
 */

import type {
  ApprovalMode,
  ModelReasoningEffort,
  SandboxMode,
  WebSearchMode,
} from '@openai/codex-sdk'

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
  /**
   * Advertise `capabilities.vision`. Defaults to `true`: image content is
   * materialized to a temp file and forwarded as `{type:'local_image', path}`
   * per the codex-sdk Input schema. Set `false` for codex configurations
   * pinned to a known text-only model — the framework gate then rejects
   * image prompts at step start with no codex turn ever started.
   */
  vision?: boolean
  /**
   * Whether codex enforces its own OS sandbox. Default `true`.
   *
   * Codex's `workspace-write` sandbox uses Linux user namespaces / bubblewrap
   * to confine file and shell access to the workspace. In environments that
   * can't grant unprivileged user namespaces (many CI runners and containers),
   * that sandbox cannot initialize and every write/exec fails — codex finishes
   * the turn having done nothing.
   *
   * Set `false` for **gateway-as-trust-boundary** deployments (the same posture
   * the in-process pi-sdk backend already runs in): codex runs with no OS
   * sandbox (`danger-full-access`), and the declared fs/exec/network policy is
   * the skelm-side boundary contract — validated and audited by the gateway,
   * not OS-enforced by codex. The mapper still refuses to escalate when an
   * explicit approval policy is set. Leave `true` (the default) wherever
   * codex's sandbox can run so codex keeps enforcing it natively.
   */
  osSandbox?: boolean
}

/**
 * Resolved Codex SDK options after skelm permissions are applied. Produced
 * by `permission-mapper.ts` and fed into `Codex.startThread()`.
 */
export interface MappedCodexPolicy {
  sandboxMode: SandboxMode
  approvalPolicy: ApprovalMode
  networkAccessEnabled: boolean
  /**
   * Codex's built-in web search bypasses `networkAccessEnabled` (that flag
   * governs sandbox-shell egress only). When networkEgress is 'deny' we set
   * webSearchMode to 'disabled' too so the agent cannot reach the public
   * web through its built-in tool.
   */
  webSearchMode: WebSearchMode
  webSearchEnabled: boolean
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
