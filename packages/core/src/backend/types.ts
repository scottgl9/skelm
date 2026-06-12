// Core backend SPI types: request/response shapes, capabilities, and the
// SkelmBackend interface. Error classes live in ./errors.ts; agentmemory
// types live in ./agentmemory.ts.

import type { McpHost } from '../mcp/host.js'
import type { McpServerConfig } from '../mcp/types.js'
import type { AgentPermissions, ResolvedPolicy } from '../permissions.js'
import type { SkelmSchema } from '../schema.js'
import type { Skill } from '../skills.js'
import type { AgentmemoryHandle } from './agentmemory.js'

export type { McpServerConfig }

export type BackendId = string

/** Discriminator describing how the backend handles permissions. */
export type ToolPermissionEnforcement = 'native' | 'wrapped' | 'advisory' | 'unsupported'

/** What the backend can do; the runtime checks before delegating. */
export interface BackendCapabilities {
  /** Single-shot inference (drives infer()). */
  prompt: boolean
  /** Streaming token output. */
  streaming: boolean
  /** Long-lived sessions across turns. */
  sessionLifecycle: boolean
  /** Per-step MCP server attachment. */
  mcp: boolean
  /** Native skill loading. */
  skills: boolean
  /** Honors the `model` field on the step. */
  modelSelection: boolean
  /** How the backend honors permissions. */
  toolPermissions: ToolPermissionEnforcement
  /**
   * Accepts image content parts in PromptMessage / InferenceRequest. Backends
   * that omit or set this to false will be rejected at the infer-step handler
   * when image parts are submitted. Default-deny: prefer omitting over
   * declaring `true` if image handling is not wired through.
   */
  vision?: boolean
  /**
   * Backend wires `BackendContext.agentmemory` through its run path
   * (observe / search / session lifecycle calls). When omitted or false,
   * the runner refuses a step whose resolved policy permits any
   * agentmemory op — silently no-oping was the prior failure mode and
   * masked backends that forgot the integration. Set this to `true` only
   * after the backend's run() actually calls the handle.
   */
  agentmemory?: boolean
}

/**
 * A multimodal-aware piece of message content. Text is the common case;
 * images carry base64-encoded bytes (no `data:` prefix) and an explicit
 * mime type so backends can map to provider-specific shapes.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
      /** Base64 bytes only — no `data:<mime>;base64,` prefix. */
      data: string
    }

/** Single message in a chat-style prompt. */
export interface PromptMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /**
   * Plain text or a sequence of typed content parts. Most callers use the
   * string form. Image parts are only honored by backends that report
   * `capabilities.vision === true`; submitting an image part to a non-vision
   * backend fails at the infer-step handler with a BackendCapabilityError.
   */
  content: string | readonly ContentPart[]
  /** Optional tool_call_id for tool-result messages. */
  toolCallId?: string
}

/** Token / cost usage reported by the backend per call. */
export interface Usage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  reasoningTokens?: number
  costUsd?: number
  extras?: Record<string, number>
}

/** Request shape for `infer()`. */
export interface InferenceRequest {
  /** Chat-style messages. */
  messages: readonly PromptMessage[]
  /** Optional system prompt prepended to messages. */
  system?: string
  /** Backend-specific model id. */
  model?: string
  /** Sampling temperature. */
  temperature?: number
  /** Hard cap on generated tokens. */
  maxTokens?: number
  /**
   * If supplied, the backend must return a structured value matching this
   * schema in `InferenceResponse.structured`. The runtime validates again before
   * surfacing as the step output, so backend-side validation is belt; the
   * framework is braces.
   */
  outputSchema?: SkelmSchema
}

/** Response shape for `infer()`. */
export interface InferenceResponse {
  /** Free-form text (when no outputSchema is requested). */
  text?: string
  /** Structured output (when outputSchema was requested). */
  structured?: unknown
  /**
   * Reasoning/"thinking" trace from reasoning-mode models (Qwen 3.x,
   * DeepSeek-R1, o1-style). Populated when the upstream surfaces a
   * separate `reasoning_content` field. Distinct from `text`: do NOT
   * concatenate without an explicit caller opt-in.
   */
  reasoning?: string
  /**
   * Why the upstream stopped: `'stop'` (natural end), `'length'`
   * (`max_tokens` truncated the output — `text` may be empty if the
   * cap fits inside a reasoning block), `'tool_calls'`, `'content_filter'`,
   * or a backend-specific string. Populated when the backend can
   * determine it; absence does not imply `'stop'`.
   */
  finishReason?: string
  /** Token / cost accounting. */
  usage?: Usage
}

/** Request shape for `run()` — multi-turn agent loop. */
export interface AgentRequest {
  /**
   * User prompt / task description. Backends that declare
   * `capabilities.vision === true` accept multimodal `ContentPart[]`; other
   * backends will reject image-bearing prompts at step start with
   * `BackendCapabilityError`.
   */
  prompt: string | readonly ContentPart[]
  /** Optional system prompt. */
  system?: string
  /**
   * How `system` composes with the backend's built-in default. `'extend'`
   * (default) prepends the default; `'replace'` drops it.
   */
  systemPromptMode?: 'extend' | 'replace'
  /**
   * When `systemPromptMode === 'replace'`, controls whether AGENTS.md / SOUL.md
   * still get injected. Default true.
   */
  systemPromptIncludeAgentDef?: boolean
  /** Hard cap on agent turns. */
  maxTurns?: number
  /** Optional working directory hint for the agent. */
  cwd?: string
  /**
   * Resolved permission policy. Backends that report
   * `toolPermissions: 'native'` enforce these themselves; backends with
   * `'wrapped'` ask the runtime per call; backends with `'advisory'`
   * receive the policy but do not enforce it, and the runtime emits
   * operator-visible diagnostics; backends with `'unsupported'` fail at
   * step start when the policy is non-empty.
   */
  permissions?: ResolvedPolicy
  /** MCP servers to attach for this agent run. */
  mcpServers?: readonly McpServerConfig[]
  /** Skill IDs to load and inject into the agent context before the run. */
  skills?: readonly string[]
  /**
   * Secrets resolved by the runner from the step's declared `secrets: [...]`.
   * Backends should inject these as environment variables on tool/exec calls.
   * Never log values.
   */
  secrets?: Readonly<Record<string, string>>
  /** When set, the runtime expects a structured value matching this schema. */
  outputSchema?: SkelmSchema
  /** Agent definition loaded from AGENTS.md (and optional SOUL.md). */
  agentDef?: AgentDefinition
  /**
   * Stable session identifier the backend can use to resume a prior
   * conversation (e.g. Codex's session-id, opencode's session file).
   * Set by the runner when the step opts into session continuity;
   * absent for one-shot agent calls.
   */
  sessionId?: string
}

/** Agent definition loaded from AGENTS.md. */
export interface AgentDefinition {
  /** Required: agent name from AGENTS.md. */
  name: string
  /** Optional: soul content from SOUL.md. */
  soul?: string
  /** Required: instructions from AGENTS.md. */
  instructions: string
}

/** Response shape for `run()`. */
export interface AgentResponse {
  /** Final assistant text. */
  text?: string
  /** Final structured value (when outputSchema was requested). */
  structured?: unknown
  /** Reason the agent stopped. */
  stopReason?: string
  /**
   * Reasoning/"thinking" trace from reasoning-mode models on the last
   * turn. Same shape as `InferenceResponse.reasoning`. See that field for
   * caveats.
   */
  reasoning?: string
  /** Token / cost accounting. */
  usage?: Usage
}

/** Context handed to a backend per call. */
export interface BackendContext {
  /** Aborts when the run is cancelled or the gateway drains. */
  signal: AbortSignal
  /** Resolved permission policy for this run when the step declared one. */
  permissions?: ResolvedPolicy
  /**
   * Raw `AgentPermissions` object the workflow author wrote on the step,
   * before defaults and profiles were merged in. Backends use this to tell
   * which dimensions the user *explicitly* declared vs. which fell out of
   * default-deny resolution. Undefined when the step had no `permissions`
   * field at all.
   */
  declaredPermissions?: AgentPermissions
  /** Optional MCP host available to wrapped-tool backends. */
  mcpHost?: McpHost
  /**
   * Policy-enforcing fetch wrapper. When a network policy is set on the
   * step, backends should use this instead of globalThis.fetch so outbound
   * requests are checked against the allowedHosts / deny policy. Falls back
   * to globalThis.fetch when not supplied (e.g. backends called without a
   * policy, or via the contract test harness).
   */
  fetch?: typeof globalThis.fetch
  /**
   * Policy-enforcing skill loader. Returns the skill body when the resolved
   * policy permits loading the given skill id, or null when the id is unknown
   * or the policy denies it. Backends that support native skill loading
   * (capabilities.skills = true) should call this instead of reading skill
   * files directly so the canLoadSkill enforcement path fires.
   * Undefined when no skill registry is available.
   */
  loadSkill?: (skillId: string) => Promise<Skill | null>
  /**
   * Egress token for network proxy authentication. When provided, the backend
   * should use this token in Proxy-Authorization: Bearer <token> header for
   * outbound HTTP requests through the egress proxy. The token maps to a
   * network policy that the proxy enforces. Undefined when no network policy
   * is declared or the gateway does not provide tokens.
   */
  egressToken?: string
  /**
   * Per-step environment variables to inject into agent subprocesses for
   * outbound network proxying. Typically includes `HTTP_PROXY`, `HTTPS_PROXY`,
   * and `SKELM_EGRESS_TOKEN` — with the egress token already encoded as the
   * URL credential of `HTTP_PROXY` so standard HTTP clients send
   * `Proxy-Authorization: Basic <…>` automatically. Subprocess backends
   * should merge this into the spawned child's env. Undefined when the
   * runtime has no egress proxy or no token was registered for this step.
   */
  proxyEnv?: Record<string, string>
  /**
   * Optional callback invoked by backends as partial output arrives.
   * The `delta` is a text chunk (not cumulative). Backends that support
   * streaming call this repeatedly during generation; backends that don't
   * can ignore it.
   */
  onPartial?: (delta: string) => void
  /**
   * Optional event bus the backend (or any sub-component it manages, like
   * an McpHost it brought up itself) can publish to. The runner subscribes
   * to `tool.call` / `tool.result` events on this bus to write audit
   * entries. Without this, native-tool backends (e.g. `@skelm/agent` when
   * it owns its own McpHost) emit no audit trail for tool dispatch.
   *
   * Backends should pair `events` with `runId` and `stepId` when forwarding
   * to McpHost so the audit entries are correctly attributed.
   */
  events?: { publish(event: unknown): void }
  /** Run id of the active run; supplied alongside `events`. */
  runId?: string
  /** Step id of the active step; supplied alongside `events`. */
  stepId?: string
  /**
   * Gateway-owned agentmemory handle. Present only when the gateway has the
   * agentmemory integration configured AND the step's resolved policy
   * permits at least one agentmemory operation. Backends should call its
   * methods unconditionally when present — each method internally enforces
   * `canUseAgentmemory` and surfaces denials as `permission.denied` events
   * rather than throwing. Undefined disables every agentmemory hook silently.
   */
  agentmemory?: AgentmemoryHandle
  /**
   * Hand off to another agent/pipeline by id and collect its result. Present
   * only when the runtime can resolve pipelines (a `pipelineRegistry` is wired)
   * AND the step has a resolved policy. Backends expose this to the agent as a
   * `delegate` tool, gated by `TrustEnforcer.canDelegate`. The runtime bounds
   * the child to this step's resolved policy and refuses cycles / excess depth.
   * Undefined disables delegation for the step.
   */
  delegate?: (agentId: string, input: unknown) => Promise<DelegateResult>
}

/** Structured result returned to a delegating agent by the `delegate` tool. */
export interface DelegateResult {
  /** Whether the delegated child run reached a terminal completed state. */
  readonly status: 'completed' | 'failed'
  /** The child run id, for correlation in audit / events. */
  readonly runId: string
  /** The child's final output (present when `status === 'completed'`). */
  readonly output?: unknown
  /** A human-readable failure summary (present when `status === 'failed'`). */
  readonly error?: string
}

/**
 * The pluggable surface for LLM and agent backends. Implementers must set
 * `capabilities` truthfully — a backend that lies about its capabilities
 * is a security defect, not an ergonomic shortcut.
 */
export interface SkelmBackend {
  readonly id: BackendId
  readonly label?: string
  readonly capabilities: BackendCapabilities

  /** Single-shot inference (powers `infer()`). */
  inference?(req: InferenceRequest, ctx: BackendContext): Promise<InferenceResponse>

  /** Multi-turn agent loop (powers `agent()`). */
  run?(req: AgentRequest, ctx: BackendContext): Promise<AgentResponse>

  /** Optional teardown when the registry is disposed. */
  dispose?(): Promise<void>
}
