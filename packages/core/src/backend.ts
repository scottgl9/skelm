// SkelmBackend — the SPI for LLM providers, agent runtimes, and any
// other inference/execution backend skelm calls into.
//
// Two methods: `infer()` powers `infer()` steps (single-shot inference);
// `run()` powers `agent()` steps (multi-turn loops). A backend may
// implement only one. The capability flags tell the runtime what the
// backend can and cannot enforce natively.

import { RegistryError } from './errors.js'
import type { McpHost } from './mcp/host.js'
import type { ResolvedPolicy } from './permissions.js'
import type { SkelmSchema } from './schema.js'

export type BackendId = string

export type { McpServerConfig } from './mcp/types.js'
import type { McpServerConfig } from './mcp/types.js'

/** Discriminator describing how the backend handles permissions. */
export type ToolPermissionEnforcement = 'native' | 'wrapped' | 'unsupported'

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
   * `'wrapped'` ask the runtime per call; backends with `'unsupported'`
   * fail at step start when the policy is non-empty.
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
  declaredPermissions?: import('./permissions.js').AgentPermissions
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
  loadSkill?: (skillId: string) => Promise<import('./skills.js').Skill | null>
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
 * Minimal interface backends consume; the concrete implementation lives in
 * `@skelm/agentmemory` and is wired by the gateway. Method bodies must be
 * cheap to call when the underlying server is unreachable — backends invoke
 * `observe` after every tool call and should never have the agent loop block
 * on memory I/O.
 */
export interface AgentmemoryHandle {
  /** Start a session at agent launch; idempotent on the session id. */
  startSession(input: {
    sessionId: string
    project?: string
    cwd?: string
    model?: string
    tags?: readonly string[]
  }): Promise<void>
  /** Mark the session ended at dispose; idempotent. */
  endSession(input: { sessionId: string }): Promise<void>
  /**
   * Record an observation (tool use, file event, etc). Fire-and-forget from
   * the backend's perspective — the implementation absorbs network failures.
   */
  observe(input: {
    sessionId: string
    hookType: string
    data: unknown
    project?: string
    cwd?: string
  }): Promise<void>
  /**
   * Hybrid search (BM25 + vector + graph). Backends typically call this once
   * per turn to fetch context to prepend to the system prompt.
   */
  smartSearch(input: {
    query: string
    limit?: number
    sessionId?: string
  }): Promise<AgentmemorySearchResult>
  /**
   * Fetch a token-budgeted context block for direct prompt injection. The
   * upstream server requires a `sessionId`; omit only when you have none (the
   * call then returns an empty block rather than throwing).
   */
  context(input: {
    sessionId?: string
    project?: string
    query: string
    tokenBudget?: number
  }): Promise<AgentmemoryContextBlock>
  /**
   * Explicitly persist an insight (the author-driven counterpart to the
   * automatic `observe` capture). Custom step/backend code calls this; the
   * built-in backend loops do not.
   */
  save(input: {
    sessionId?: string
    project?: string
    title: string
    content: string
    concepts?: readonly string[]
  }): Promise<AgentmemorySaveResult>
  /** Recall recent or by-session memories (distinct from hybrid `smartSearch`). */
  recall(input: {
    sessionId?: string
    project?: string
    limit?: number
  }): Promise<AgentmemoryRecallResult>
  /** List recent sessions with highlights. */
  sessions(input: { project?: string; limit?: number }): Promise<AgentmemorySessionsResult>
  /** Traverse the knowledge graph over concepts, files, and patterns. */
  graphQuery(input: {
    project?: string
    query: string
    limit?: number
  }): Promise<AgentmemoryGraphResult>
}

export interface AgentmemorySearchHit {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly score?: number
  readonly concepts?: readonly string[]
}

export interface AgentmemorySearchResult {
  readonly hits: readonly AgentmemorySearchHit[]
}

export interface AgentmemoryContextBlock {
  readonly text: string
  readonly tokenEstimate?: number
}

export interface AgentmemorySaveResult {
  readonly id: string
}

export interface AgentmemoryRecallResult {
  readonly hits: readonly AgentmemorySearchHit[]
}

export interface AgentmemorySessionSummary {
  readonly id: string
  readonly title?: string
  readonly startedAt?: number
  readonly highlights?: readonly string[]
}

export interface AgentmemorySessionsResult {
  readonly sessions: readonly AgentmemorySessionSummary[]
}

export interface AgentmemoryGraphNode {
  readonly id: string
  readonly label: string
  readonly kind?: string
}

export interface AgentmemoryGraphEdge {
  readonly from: string
  readonly to: string
  readonly relation?: string
}

export interface AgentmemoryGraphResult {
  readonly nodes: readonly AgentmemoryGraphNode[]
  readonly edges: readonly AgentmemoryGraphEdge[]
}

/** Factory context handed to the gateway's per-step agentmemory factory. */
export interface AgentmemoryHandleFactoryContext {
  readonly runId: string
  readonly stepId: string
  /** Bound `TrustEnforcer.canUseAgentmemory` for the step's resolved policy. */
  readonly canUseAgentmemory: (
    op: import('./permissions.js').AgentmemoryOperation,
  ) => import('./permissions.js').EnforceDecision
  /** Optional event bus; the handle publishes permission.denied / agentmemory.error. */
  readonly events?: { publish(event: unknown): void }
}

/**
 * Factory returning a per-step `AgentmemoryHandle`. The gateway constructs
 * one of these from its `AgentmemoryClient` and hands it through
 * `RunOptions.agentmemoryHandleFactory`. Undefined disables the integration.
 */
export type AgentmemoryHandleFactory = (
  ctx: AgentmemoryHandleFactoryContext,
) => AgentmemoryHandle | undefined

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

/** Thrown when a backend is asked to do something it cannot. */
export class BackendCapabilityError extends Error {
  override readonly name = 'BackendCapabilityError'
  constructor(
    message: string,
    readonly backendId: BackendId,
    readonly capability: keyof BackendCapabilities,
  ) {
    super(message)
  }
}

/** Thrown when no backend is registered for a step's needs. */
export class BackendNotFoundError extends Error {
  override readonly name = 'BackendNotFoundError'
}

/** Thrown when a registered backend is unavailable or failed to initialize. */
export class BackendUnavailableError extends Error {
  override readonly name = 'BackendUnavailableError'
  constructor(
    message: string,
    readonly backendId: BackendId,
  ) {
    super(message)
  }
}

/**
 * Thrown when the upstream LLM stopped because it hit a `max_tokens` cap
 * (`finish_reason: 'length'`) and the visible assistant `text` was empty
 * (typical of reasoning-mode models whose entire output was consumed by
 * an internal monologue). Callers can distinguish this from a genuine
 * "upstream returned nothing" failure and decide whether to retry with
 * a larger cap, surface `reasoning`, or fail.
 */
export class LLMTruncatedError extends Error {
  override readonly name = 'LLMTruncatedError'
  constructor(
    message: string,
    readonly finishReason: string,
    readonly reasoning?: string,
  ) {
    super(message)
  }
}

/**
 * Thrown when a backend factory is given missing or invalid options
 * (no API key, missing model id, mutually-exclusive flags, etc).
 * Distinct from BackendUnavailableError, which signals a runtime
 * failure on an already-built backend.
 */
export class BackendConfigError extends Error {
  override readonly name = 'BackendConfigError'
  constructor(
    message: string,
    readonly backendId?: BackendId,
  ) {
    super(message)
  }
}

/**
 * Thrown when an upstream LLM/agent provider returns an error response,
 * a malformed response, or a non-2xx status. `status` is the HTTP code
 * when known; `cause` carries the parsed upstream body when present.
 */
export class BackendUpstreamError extends Error {
  override readonly name = 'BackendUpstreamError'
  constructor(
    message: string,
    readonly backendId?: BackendId,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Thrown when a backend encounters a network/fetch error (DNS failure,
 * connection refused, timeout, TLS error, etc.). Distinguishable from
 * BackendUpstreamError (which means we got a response but it was an error)
 * and BackendConfigError (which means local configuration is wrong).
 */
export class BackendNetworkError extends Error {
  override readonly name = 'BackendNetworkError'
  constructor(
    message: string,
    readonly backendId?: BackendId,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Thrown when an upstream provider rejects the request as unauthenticated /
 * unauthorized (401/403 family). Previously redeclared per backend
 * (opencode, pi, pi-sdk); consolidated here so callers can `catch` once.
 */
export class BackendAuthenticationError extends Error {
  override readonly name = 'BackendAuthenticationError'
  constructor(
    message: string,
    readonly backendId?: BackendId,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Thrown when an upstream provider rejects the request due to rate limiting
 * (429 / Retry-After). Consolidated from per-backend variants.
 */
export class BackendRateLimitError extends Error {
  override readonly name = 'BackendRateLimitError'
  constructor(
    message: string,
    readonly backendId?: BackendId,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Thrown when a backend operation exceeds its configured timeout, either
 * client-side (AbortSignal trip) or upstream-reported. Distinct from
 * BackendNetworkError — the connection was fine, the work was just too slow.
 */
export class BackendTimeoutError extends Error {
  override readonly name = 'BackendTimeoutError'
  constructor(
    message: string,
    readonly backendId?: BackendId,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Thrown when an agent session operation (create, prompt, mcp.add,
 * subscribe) fails. Wraps the upstream error payload as `cause`.
 */
export class BackendSessionError extends Error {
  override readonly name = 'BackendSessionError'
  constructor(
    message: string,
    readonly backendId?: BackendId,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Thrown by an agent loop when the configured `maxTurns` budget is
 * exceeded without the agent terminating. Caller policy decides whether
 * to retry with a larger budget or fail the step.
 */
export class AgentMaxTurnsError extends Error {
  override readonly name = 'AgentMaxTurnsError'
  constructor(
    readonly maxTurns: number,
    readonly backendId?: BackendId,
  ) {
    super(`agent exceeded max turns (${maxTurns})`)
  }
}

/**
 * Minimal in-memory registry. The gateway will eventually use this; tests
 * already do. Resolution order: explicit backend id → first backend that
 * supports the requested capability → throw.
 */
export class BackendRegistry {
  private readonly backends = new Map<BackendId, SkelmBackend>()

  register(backend: SkelmBackend): void {
    if (this.backends.has(backend.id)) {
      throw new RegistryError(`backend already registered: ${backend.id}`, 'backend', backend.id)
    }
    this.backends.set(backend.id, backend)
  }

  has(id: BackendId): boolean {
    return this.backends.has(id)
  }

  /**
   * Idempotent register: adds the backend if its id is free, otherwise leaves
   * the existing entry untouched. Used when a runtime-activated project's
   * backends are absorbed into a running gateway — an already-trusted id is
   * never silently replaced by a later config.
   */
  registerIfAbsent(backend: SkelmBackend): 'registered' | 'exists' {
    if (this.backends.has(backend.id)) return 'exists'
    this.backends.set(backend.id, backend)
    return 'registered'
  }

  /** Pick a backend by id, falling back to first one that has `prompt`. */
  resolveForLlm(opts: { backendId?: BackendId | undefined }): SkelmBackend {
    if (opts.backendId !== undefined) {
      const found = this.backends.get(opts.backendId)
      if (!found) {
        throw new BackendNotFoundError(`backend not registered: ${opts.backendId}`)
      }
      if (!found.capabilities.prompt || typeof found.inference !== 'function') {
        throw new BackendCapabilityError(
          `backend ${opts.backendId} does not support infer() steps. Use a backend with single-shot inference (e.g. anthropic, openai, pi-sdk), or rewrite as agent({ maxTurns: 1 }).`,
          opts.backendId,
          'prompt',
        )
      }
      return found
    }
    for (const candidate of this.backends.values()) {
      if (candidate.capabilities.prompt && typeof candidate.inference === 'function') {
        return candidate
      }
    }
    throw new BackendNotFoundError('no backend with prompt capability is registered')
  }

  /** Pick a backend for an agent() step. */
  resolveForAgent(opts: { backendId?: BackendId | undefined }): SkelmBackend {
    if (opts.backendId !== undefined) {
      const found = this.backends.get(opts.backendId)
      if (!found) {
        throw new BackendNotFoundError(`backend not registered: ${opts.backendId}`)
      }
      if (typeof found.run !== 'function') {
        throw new BackendCapabilityError(
          `backend ${opts.backendId} does not support agent() steps`,
          opts.backendId,
          'prompt',
        )
      }
      return found
    }
    for (const candidate of this.backends.values()) {
      if (typeof candidate.run === 'function') return candidate
    }
    throw new BackendNotFoundError('no backend with run() capability is registered')
  }

  list(): readonly SkelmBackend[] {
    return [...this.backends.values()]
  }

  async dispose(): Promise<void> {
    for (const b of this.backends.values()) {
      if (typeof b.dispose === 'function') await b.dispose()
    }
    this.backends.clear()
  }
}
