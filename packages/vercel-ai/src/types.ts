import type { LanguageModel, ToolSet } from 'ai'

/** Mirrors ai's ProviderOptions (a per-provider record of arbitrary key/value options). */
export type VercelAiProviderOptions = Record<string, Record<string, unknown>>

export interface VercelAiBackendOptions {
  /** Backend id (default: 'vercel-ai'). */
  id?: string
  /** Human-readable label. */
  label?: string
  /** Required: a Vercel AI LanguageModel instance, e.g. openai('gpt-4o'). */
  model: LanguageModel
  /** Tool set the model can call. Filtered at run() time by policy.allowedTools. */
  tools?: ToolSet
  /** Base system prompt prepended to req.system + agentDef + skill bodies. */
  systemPrompt?: string
  /** Sampling temperature. */
  temperature?: number
  /** Hard cap on generated tokens per call. */
  maxOutputTokens?: number
  /** Maximum simultaneous calls (default 4; 0 = unlimited). */
  maxConcurrent?: number
  /** Per-call timeout in ms (default 300_000). */
  timeout?: number
  /**
   * Provider-specific options forwarded to generateText. Useful for disabling
   * reasoning on models that emit it by default (e.g. qwen3, gpt-5):
   *
   *   providerOptions: { openai: { reasoningEffort: 'minimal' } }
   *
   * The backend always returns only text content (`result.text`); reasoning
   * blocks are ignored. But on some models all tokens go into reasoning
   * unless the provider is told not to.
   */
  providerOptions?: VercelAiProviderOptions
}
