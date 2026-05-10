/**
 * @skelm/agent — First-party skelm agent backend
 *
 * A SkelmBackend that drives a multi-turn agent loop using an
 * OpenAI-compatible chat completions endpoint, with native permission
 * enforcement for tools, filesystem, and network access.
 */

export {
  createSkelmAgentBackend,
  type SkelmAgentOptions,
} from './backend.js'
export type { SkelmAgentBackendCapabilities } from './types.js'
