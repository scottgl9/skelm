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
  /**
   * Per-model vision allowlist (test_plan finding-123).
   *
   * The framework's vision capability check is backend-coarse: it asks
   * `capabilities.vision` on the *backend*, not per-model. vercel-ai is
   * always vision-capable, but the specific `LanguageModel` instance the
   * caller wires up (e.g. `openai.chat('qwen3-text-only')`) may target a
   * model that the upstream silently strips images from — producing a
   * "completely blank or white" hallucination instead of an error.
   *
   * When this option is set, prompts that carry image content are rejected
   * with `BackendCapabilityError` *before* dispatch unless the resolved
   * model id appears in the list. Compared against `modelId`, which is
   * derived from the `LanguageModel` instance (`.modelId` for ai-sdk v4+;
   * falls back to `provider:modelId`).
   *
   * Leave unset to preserve the prior behavior (no per-model check; image
   * content is always forwarded).
   */
  visionModels?: readonly string[]
}
