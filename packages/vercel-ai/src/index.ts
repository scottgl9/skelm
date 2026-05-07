/**
 * @skelm/vercel-ai — Vercel AI SDK backend for skelm.
 *
 * Wrap any Vercel AI `LanguageModel` (from `@ai-sdk/openai`,
 * `@ai-sdk/anthropic`, etc.) and run it under skelm's permission policy.
 */

export { createVercelAiBackend } from './backend.js'
export { VercelAiBackendError, VercelAiBackendTimeoutError } from './errors.js'
export { applyPolicyToTools, wrapToolWithPolicy } from './permissions.js'
export type { VercelAiBackendOptions, VercelAiProviderOptions } from './types.js'
