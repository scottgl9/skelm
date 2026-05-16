// SkelmBackend — the SPI for LLM providers, agent runtimes, and any
// other inference/execution backend skelm calls into.
//
// Two methods: `infer()` powers `llm()` steps (single-shot inference);
// `run()` powers `agent()` steps (multi-turn loops). A backend may
// implement only one. The capability flags tell the runtime what the
// backend can and cannot enforce natively.

import type { McpHost } from './mcp/host.js'
import type { ResolvedPolicy } from './permissions.js'
import type { SkelmSchema } from './schema.js'

export type BackendId = string

export type McpServerConfig =
  | {
      id: string
      transport: 'stdio'
      command: string
      args?: readonly string[]
      env?: Readonly<Record<string, string>>
    }
  | {
      id: string
      transport: 'http' | 'sse'
      url: string
      headers?: Readonly<Record<string, string>>
    }

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
}

/** Single message in a chat-style prompt. */
export interface PromptMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
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
export interface InferRequest {
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
   * schema in `InferResponse.structured`. The runtime validates again before
   * surfacing as the step output, so backend-side validation is belt; the
   * framework is braces.
   */
  outputSchema?: SkelmSchema
}

/** Response shape for `infer()`. */
export interface InferResponse {
  /** Free-form text (when no outputSchema is requested). */
  text?: string
  /** Structured output (when outputSchema was requested). */
  structured?: unknown
  /** Token / cost accounting. */
  usage?: Usage
}

/** Request shape for `run()` — multi-turn agent loop. */
export interface AgentRequest {
  /** User prompt / task description. */
  prompt: string
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

  /** Single-shot inference (powers `llm()`). */
  infer?(req: InferRequest, ctx: BackendContext): Promise<InferResponse>

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
 * Minimal in-memory registry. The gateway will eventually use this; tests
 * already do. Resolution order: explicit backend id → first backend that
 * supports the requested capability → throw.
 */
export class BackendRegistry {
  private readonly backends = new Map<BackendId, SkelmBackend>()

  register(backend: SkelmBackend): void {
    if (this.backends.has(backend.id)) {
      throw new Error(`backend already registered: ${backend.id}`)
    }
    this.backends.set(backend.id, backend)
  }

  /** Pick a backend by id, falling back to first one that has `prompt`. */
  resolveForLlm(opts: { backendId?: BackendId | undefined }): SkelmBackend {
    if (opts.backendId !== undefined) {
      const found = this.backends.get(opts.backendId)
      if (!found) {
        throw new BackendNotFoundError(`backend not registered: ${opts.backendId}`)
      }
      if (!found.capabilities.prompt || typeof found.infer !== 'function') {
        throw new BackendCapabilityError(
          `backend ${opts.backendId} does not support llm() steps. Use a backend with single-shot inference (e.g. anthropic, openai, pi-sdk), or rewrite as agent({ maxTurns: 1 }).`,
          opts.backendId,
          'prompt',
        )
      }
      return found
    }
    for (const candidate of this.backends.values()) {
      if (candidate.capabilities.prompt && typeof candidate.infer === 'function') {
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
