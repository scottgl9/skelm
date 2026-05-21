/**
 * Types for @skelm/pi - Pi coding agent backend
 */

export interface PiSdkBackendOptions {
  /** Backend id (default: 'pi-sdk') */
  id?: string
  /** Human-readable label */
  label?: string
  /** Working directory for pi's project-local discovery */
  cwd?: string
  /** Request timeout in ms (default: 300_000 = 5 min) */
  timeout?: number
  /**
   * Maximum simultaneous pi sessions. Defaults to 4. Set to 0 for unlimited.
   * Excess calls are queued until a slot opens.
   */
  maxConcurrent?: number
  /**
   * Replace pi's coding-agent system prompt with a custom base.
   * When omitted, pi's default prompt is kept and req.system / skills are
   * appended after it.
   */
  systemPrompt?: string
  /**
   * Disable pi's extension loading from .pi/extensions/.
   * Default: true — extensions can expand the tool surface in ways skelm
   * cannot audit; disabled by default for predictable sandboxing.
   */
  noExtensions?: boolean
  /**
   * Disable pi's built-in skill loading from .pi/skills/.
   * Default: true — skelm injects skills itself; loading pi's own skills
   * would cause duplicates.
   */
  noSkills?: boolean
  /**
   * Disable pi's cwd context file discovery (AGENTS.md, .pi/context/).
   * Default: false — project context files are useful and safe.
   */
  noContextFiles?: boolean
  /**
   * Advertise `capabilities.vision`. Defaults to `true`: image parts in the
   * prompt are forwarded to pi via `session.prompt(text, { images })`. Whether
   * the configured pi model actually accepts images depends on its
   * `~/.pi/agent/models.json` entry (the model's `input` field). Set
   * `vision: false` to flip on the framework's vision gate for deployments
   * pinned to a text-only pi model.
   */
  vision?: boolean
  /**
   * Provider name to register with pi's `ModelRegistry` at session start.
   * Defaults to `process.env.OPENAI_PROVIDER ?? 'openai'`. Pass an explicit
   * value to pin a different provider (e.g. `'anthropic'`).
   *
   * Together with `model` / `baseUrl` / `apiKey`, this lets pi-sdk be pointed
   * at a local OpenAI-compatible server (sglang, vLLM, llama.cpp, ollama)
   * without hand-editing `~/.pi/agent/models.json`. Per finding-119 the env
   * vars are honored automatically so pi-sdk reaches the same endpoint as
   * every other skelm backend in the same config.
   *
   * `OPENAI_PROVIDER` is a pi-sdk-specific addition (the cross-backend
   * convention is just `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`).
   * It exists because pi's ModelRegistry is keyed by provider name; if you
   * want to register the override against a non-`openai` provider (e.g.
   * `'anthropic'`) without an explicit option, this is the knob.
   */
  provider?: string
  /**
   * Model id used when registering the provider above. Defaults to
   * `process.env.OPENAI_MODEL` when set, otherwise pi's own default
   * (`gpt-5.4` at time of writing). Explicit value overrides env.
   */
  model?: string
  /**
   * Base URL of the OpenAI-compatible endpoint. Defaults to
   * `process.env.OPENAI_BASE_URL` when set. Trailing `/v1` is preserved
   * verbatim — the pi SDK does not append it itself.
   */
  baseUrl?: string
  /**
   * API key for the configured provider. Defaults to
   * `process.env.OPENAI_API_KEY` when set. Local servers that ignore auth
   * still need a non-empty value (e.g. `"unused"`); pass an explicit string
   * to override.
   */
  apiKey?: string
  /**
   * Optional `contextWindow` (in tokens) declared on the registered model
   * entry. Defaults to 131_072 — a permissive ceiling that works for most
   * modern local-LLM servers (sglang qwen3-coder, vLLM llama-3.1, …) and
   * matches pi's built-in qwen/gpt defaults. Override when pinning pi-sdk
   * at a small-context model (e.g. llama.cpp serving a 4K-context variant)
   * so pi's own context-tracking math stays honest. The value is metadata —
   * pi does not use it for hard truncation today, but downstream tooling may.
   */
  contextWindow?: number
  /**
   * Optional `maxTokens` (in tokens) declared on the registered model
   * entry. Defaults to 4096. Same metadata-only role as `contextWindow`;
   * override when targeting a model with a tighter (or looser) output cap.
   */
  maxTokens?: number
}

export interface PiBackendOptions {
  /** Backend id (default: 'pi') */
  id?: string
  /** Human-readable label */
  label?: string
  /** Path to the pi binary (default: 'pi' on PATH) */
  command?: string
  /** Provider name (e.g. 'llamacpp', 'anthropic'). Omit to use pi's default. */
  provider?: string
  /** Model ID (e.g. 'qwen36'). Omit to use pi's default. */
  model?: string
  /** Working directory for the pi process */
  cwd?: string
  /** Request timeout in ms (default: 300_000 = 5 min) */
  timeout?: number
  /**
   * Maximum simultaneous pi processes. Defaults to 4. Set to 0 for unlimited.
   * Excess calls are queued until a slot opens.
   */
  maxConcurrent?: number
  /**
   * Optional egress proxy URL to inject into subprocess environment.
   * When provided along with an egress token from the gateway, the pi process
   * will route outbound connections through the proxy for network policy enforcement.
   */
  egressProxyUrl?: string
}
