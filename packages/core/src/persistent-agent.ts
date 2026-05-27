// Persistent agents: a long-lived conversational entity (sibling to `pipeline`).
//
// Unlike a pipeline — a bounded run that starts, executes its steps, and ends —
// a persistent agent's IDENTITY and CONVERSATION outlive any single trigger
// fire. Each fire runs exactly one bounded, gateway-enforced, audited turn that
// loads the conversation for a session key, runs the agent, and saves it again.
// The conversation is durable (persisted in the run store's StateStore), so it
// survives across fires and gateway restarts. There is no resident in-process
// loop; triggers drive turns, exactly like a normal agent step is driven by a
// run. See `docs/concepts/persistent-agents.md`.

import type { AgentDefinition } from './backend.js'
import { normalizePipelineTrigger } from './builders.js'
import type { AgentPermissions } from './permissions.js'
import type { PipelineTrigger } from './types.js'

/** Author-facing definition of a persistent agent. */
export interface PersistentAgentDef<TPayload = unknown> {
  /** Stable id. Used as the trigger `workflowId` and the session namespace. */
  id: string
  description?: string
  /** Backend id, resolved like an `agent()` step's `backend`. */
  backend?: string
  model?: string
  /** System prompt prepended to every turn. */
  system?: string
  /** AGENTS.md/SOUL.md-style definition, threaded to the backend each turn. */
  agentDef?: AgentDefinition
  /**
   * Permissions for each turn. MAY set `requestUnrestricted: true` to ask for a
   * full bypass — inert unless the operator also grants this agent's id in
   * gateway config. See `docs/concepts/permissions.md`.
   */
  permissions?: AgentPermissions
  /** Max agent turns per fire. */
  maxTurns?: number
  /** Triggers that drive turns (same shape as `pipeline().triggers`). */
  triggers?: readonly PipelineTrigger[]
  /**
   * Maps a trigger payload to a stable conversation key — e.g. a Telegram
   * `chatId`, so each chat is its own durable session. Required: it is what
   * makes the agent "persistent" per conversation rather than per fire.
   */
  sessionKey: (payload: TPayload) => string
  /** Extracts the user's message text from the trigger payload. Default: `payload.text`. */
  promptOf?: (payload: TPayload) => string
  /** Shapes the reply object a queue driver's `onResult` posts. Default: `{ reply: text }`. */
  replyOf?: (text: string) => unknown
}

/** A frozen persistent-agent value. The `kind` discriminator distinguishes it
 *  from a `Pipeline` (which has `steps`) at dispatch time. */
export interface PersistentAgent<TPayload = unknown>
  extends Readonly<PersistentAgentDef<TPayload>> {
  readonly kind: 'persistent-agent'
}

/** Type guard used by the gateway dispatcher to route a fire to a turn runner. */
export function isPersistentAgent(value: unknown): value is PersistentAgent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'persistent-agent'
  )
}

/**
 * Author a persistent agent. Returns a plain immutable value; the gateway hosts
 * it and runs one enforced turn per trigger fire.
 */
export function persistentAgent<TPayload = unknown>(
  def: PersistentAgentDef<TPayload>,
): PersistentAgent<TPayload> {
  if (!def.id) {
    throw new Error('persistentAgent(): id is required')
  }
  if (typeof def.sessionKey !== 'function') {
    throw new Error(`persistentAgent(${def.id}): sessionKey must be a function`)
  }
  const out: PersistentAgent<TPayload> = {
    kind: 'persistent-agent',
    id: def.id,
    sessionKey: def.sessionKey,
    ...(def.description !== undefined && { description: def.description }),
    ...(def.backend !== undefined && { backend: def.backend }),
    ...(def.model !== undefined && { model: def.model }),
    ...(def.system !== undefined && { system: def.system }),
    ...(def.agentDef !== undefined && { agentDef: def.agentDef }),
    ...(def.permissions !== undefined && { permissions: def.permissions }),
    ...(def.maxTurns !== undefined && { maxTurns: def.maxTurns }),
    ...(def.triggers !== undefined && {
      triggers: Object.freeze(def.triggers.map((t) => normalizePipelineTrigger(def.id, t))),
    }),
    ...(def.promptOf !== undefined && { promptOf: def.promptOf }),
    ...(def.replyOf !== undefined && { replyOf: def.replyOf }),
  }
  return Object.freeze(out)
}

/** Default prompt extractor: reads `payload.text`. */
export function defaultPromptOf(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'text' in payload) {
    const text = (payload as { text: unknown }).text
    if (typeof text === 'string') return text
  }
  return ''
}

/** Default reply shaper: `{ reply: text }`. */
export function defaultReplyOf(text: string): unknown {
  return { reply: text }
}
