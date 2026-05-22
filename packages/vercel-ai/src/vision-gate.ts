/**
 * Per-model vision allowlist (finding-123 / GH #177).
 *
 * The framework's `capabilities.vision` gate is backend-coarse: vercel-ai
 * is always vision-capable, even when the caller wires up a `LanguageModel`
 * instance that points at a text-only model. The upstream provider then
 * silently strips image content and returns a hallucinated "completely
 * blank" reply.
 *
 * `assertModelSupportsImages` lets a backend instance opt into a per-model
 * allowlist. When `visionModels` is set and the prompt carries image
 * content, the model id derived from the `LanguageModel` instance is
 * checked against the list; a mismatch throws `BackendCapabilityError`
 * before dispatch.
 *
 * When `visionModels` is unset (the default), the function is a no-op so
 * existing callers are unaffected.
 */

import { BackendCapabilityError, isMultimodal } from '@skelm/core'
import type { ContentPart, PromptMessage } from '@skelm/core'
import type { LanguageModel } from 'ai'

/**
 * Return the bare model id (e.g. `'gpt-4o'`) from a `LanguageModel` instance.
 *
 * - String shorthand → the string itself.
 * - ai-sdk v4+ `LanguageModelV2` (and older v1 instances that expose
 *   `modelId: string`) → `.modelId`.
 * - Unknown shapes → `String(model)` (`[object Object]` in practice), which
 *   never matches an allowlist entry — fail-closed by default.
 *
 * For the qualified `provider:modelId` form used in error messages and
 * disambiguation, see `extractQualifiedModelId`.
 */
export function extractModelId(model: LanguageModel): string {
  if (typeof model === 'string') return model
  if (typeof model === 'object' && model !== null && 'modelId' in model) {
    const id = (model as { modelId?: unknown }).modelId
    if (typeof id === 'string' && id.length > 0) return id
  }
  return String(model)
}

/**
 * Extract a fully-qualified `provider:modelId` form for error messages and
 * allowlist matching. Returns the same value as `extractModelId` when
 * `provider` is unavailable.
 */
export function extractQualifiedModelId(model: LanguageModel): string {
  if (typeof model === 'string') return model
  if (typeof model === 'object' && model !== null && 'modelId' in model) {
    const id = (model as { modelId?: unknown }).modelId
    const provider = (model as { provider?: unknown }).provider
    if (typeof id === 'string' && id.length > 0) {
      if (typeof provider === 'string' && provider.length > 0) {
        return `${provider}:${id}`
      }
      return id
    }
  }
  return String(model)
}

function promptHasImage(prompt: AgentPromptLike): boolean {
  if (prompt === undefined) return false
  // Reuse the canonical multimodal check from core so this stays consistent
  // with how the rest of skelm decides "this message carries non-text parts."
  // `isMultimodal` accepts `string | readonly ContentPart[]` directly.
  if (!isMultimodal(prompt)) return false
  return prompt.some((p) => p.type === 'image')
}

function messagesHaveImage(messages: readonly PromptMessage[]): boolean {
  for (const m of messages) {
    if (isMultimodal(m.content) && m.content.some((p) => p.type === 'image')) return true
  }
  return false
}

type AgentPromptLike = string | readonly ContentPart[] | undefined

export interface AssertVisionArgs {
  backendId: string
  model: LanguageModel
  visionModels: readonly string[] | undefined
  /** From AgentRequest.prompt — the agent path. */
  prompt?: AgentPromptLike
  /** From InferRequest.messages — the llm() path. */
  messages?: readonly PromptMessage[]
}

/**
 * Throws `BackendCapabilityError` when a per-call `req.model` override is
 * supplied but does not match the backend's pre-bound `LanguageModel`
 * instance. Unlike OpenAI / Anthropic / @skelm/agent — which accept a
 * model id per request — vercel-ai is constructed against a specific
 * `LanguageModel` (e.g. `openai.chat('qwen35')`) and cannot route a
 * different id to a different upstream without a provider factory.
 *
 * Silently honoring the backend's bound model when callers ask for a
 * different one masks vision-routing mistakes: an operator pinning
 * `llm({ model: 'qwen3-text-only' })` against a vision-bound backend
 * would silently get the vision model's reply (finding-133). Fail loud.
 *
 * `requestedModel` is `undefined` when the step did not set `model`; in
 * that case the check is a no-op (the bound model wins, as before).
 */
export function assertModelMatchesBound(
  backendId: string,
  boundModel: LanguageModel,
  requestedModel: string | undefined,
): void {
  if (requestedModel === undefined) return
  const boundId = extractModelId(boundModel)
  const boundQualified = extractQualifiedModelId(boundModel)
  if (requestedModel === boundId || requestedModel === boundQualified) return
  // capability='modelSelection' — vercel-ai's BackendCapabilities already
  // declares `modelSelection: false`, which is exactly the contract this
  // mismatch violates. Using 'vision' here would misclassify a routing
  // failure as a vision-capability failure for any caller catching
  // BackendCapabilityError and branching on .capability.
  throw new BackendCapabilityError(
    `backend "${backendId}" is bound to model "${boundQualified}" but the step requested "${requestedModel}". vercel-ai backends route through a pre-constructed LanguageModel instance and cannot honour per-call model overrides. Register a second backend instance with the desired model, or remove the step's "model" field to use the bound one.`,
    backendId,
    'modelSelection',
  )
}

/**
 * Throws `BackendCapabilityError` if image content is present and the
 * resolved model id is not in `visionModels`. No-op when `visionModels`
 * is unset.
 */
export function assertModelSupportsImages(args: AssertVisionArgs): void {
  if (args.visionModels === undefined) return
  const hasImage =
    args.prompt !== undefined
      ? promptHasImage(args.prompt)
      : args.messages !== undefined
        ? messagesHaveImage(args.messages)
        : false
  if (!hasImage) return
  const modelId = extractModelId(args.model)
  const qualified = extractQualifiedModelId(args.model)
  // Accept either the bare model id or the `provider:modelId` form so
  // callers can disambiguate models that exist under multiple providers
  // (e.g. `gpt-4o` lives under both `openai` and `azure`).
  if (args.visionModels.includes(modelId) || args.visionModels.includes(qualified)) return
  // Surface the more informative `provider:modelId` form when available;
  // it's what the user would write in `visionModels` to silence the error.
  const displayId = qualified !== modelId ? qualified : modelId
  throw new BackendCapabilityError(
    `backend "${args.backendId}" model "${displayId}" does not support image content (not in visionModels allowlist). ` +
      `Add "${displayId}" to the backend's visionModels option, or route image prompts to a vision-capable model.`,
    args.backendId,
    'vision',
  )
}
