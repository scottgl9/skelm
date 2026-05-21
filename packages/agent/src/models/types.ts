/**
 * Model and provider type declarations for the skelm-agent registry.
 *
 * skelm runs agents as pipeline steps, not as an interactive CLI, so the
 * surface is intentionally narrow: only what affects routing, costing,
 * and request shape. UI-only metadata (icons, group ordering) is omitted.
 */

export type ModelApi = 'openai-completions' | 'openai-responses'

export type ModelInputKind = 'text' | 'image'

/**
 * Reasoning effort hint passed alongside a prompt for models that support
 * adjustable thinking budgets. Backends translate the level into a
 * provider-specific request field — currently only the OpenAI Responses API
 * has a standardized mapping; OpenAI Chat Completions has no equivalent and
 * the level is dropped silently.
 */
export type ThinkingLevel = 'none' | 'light' | 'deep'

export interface ModelCost {
  /** Cost per 1K input tokens, in USD. */
  input: number
  /** Cost per 1K output tokens, in USD. */
  output: number
  /** Cost per 1K cache-read tokens, in USD. Omit if unsupported. */
  cacheRead?: number
  /** Cost per 1K cache-write tokens, in USD. Omit if unsupported. */
  cacheWrite?: number
}

export interface ModelEntry {
  /** Provider-side model id, sent as the `model` field on the wire. */
  id: string
  /** Human-readable label for logs and metrics. Defaults to `id`. */
  name?: string
  api: ModelApi
  input: readonly ModelInputKind[]
  /** Total tokens the model can hold (input + output). */
  contextWindow: number
  /** Default cap on output tokens per request. */
  maxTokens: number
  cost: ModelCost
  /** Whether the model emits separate reasoning/thinking content. */
  reasoning: boolean
  /** Default thinking level when not overridden per request. */
  defaultThinkingLevel?: ThinkingLevel
}

export interface RegisterProviderOptions {
  baseUrl: string
  apiKey?: string
  /** Extra headers sent on every request (e.g. for OpenRouter routing). */
  headers?: Readonly<Record<string, string>>
  models: readonly ModelEntry[]
}

/**
 * Result of `ModelRegistry.find()`: a model entry stitched together with
 * the provider connection details needed to actually issue a request.
 */
export interface ResolvedModel {
  provider: string
  entry: ModelEntry
  baseUrl: string
  apiKey?: string
  headers?: Readonly<Record<string, string>>
}
