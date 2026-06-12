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
export { ModelRegistry } from './models/registry.js'
export type {
  ModelApi,
  ModelCost,
  ModelEntry,
  ModelInputKind,
  RegisterProviderOptions,
  ResolvedModel,
  ThinkingLevel,
} from './models/types.js'
export {
  AgentSession,
  type AgentSessionInit,
  type InferDispatch,
  type PromptOptions,
  type SerializedSession,
} from './session/agent-session.js'
export {
  type CompactOptions,
  type CompactionResult,
  type FindCutPointOptions,
  type ShouldCompactOptions,
  compact,
  estimateMessagesTokens,
  estimateTokens,
  findCutPoint,
  serializedSize,
  shouldCompact,
} from './session/compaction.js'
export type {
  SessionEvent,
  SessionEventListener,
  SessionPromptResult,
  Unsubscribe,
} from './session/events.js'
export {
  assertSerializedSession,
  exportSession,
  forkSession,
  importSession,
} from './session/lifecycle.js'
export type { MessageRole, SessionMessage, SessionToolCall } from './session/messages.js'
export { FileSessionStore } from './session/store/file-store.js'
export { InMemorySessionStore } from './session/store/in-memory.js'
export type { SessionStore } from './session/store/types.js'
export type {
  BrowserActionResult,
  BrowserProvider,
  BrowserScreenshot,
} from './tools/browser.js'
export { BROWSER_TOOLS } from './tools/browser.js'
export type { ArtifactHandle, StateHandle } from './tools/state.js'
export { STATE_TOOLS } from './tools/state.js'
export type { SkelmAgentBackendCapabilities } from './types.js'
