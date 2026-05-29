// Persistent workflows: a triggered workflow that terminates in a long-lived
// conversational agent turn.
//
// A persistent workflow folds the old "persistent agent" back into skelm's
// workflow model. Each trigger fire runs FRESH preamble steps (`code()`,
// `llm()`, control flow) that enrich or transform the incoming message, then
// ALWAYS ends in one bounded, gateway-enforced, audited agent turn. Only that
// terminal turn is persistent: it loads the durable conversation for a session
// key, runs the agent, and saves it again. The conversation is durable
// (persisted in the run store's StateStore), so it survives across fires and
// gateway restarts. There is no resident in-process loop; triggers drive turns.
// See `docs/concepts/persistent-workflows.md`.

import { normalizePipelineTrigger } from './builders.js'
import type { AgentPermissions } from './permissions.js'
import type { Context, PipelineTrigger, Step } from './types.js'

/** The terminal step id the turn runner synthesizes; reserved for preamble ids. */
export const PERSISTENT_TURN_STEP_ID = 'turn'

/** Author-facing definition of the persistent terminal agent of a workflow. */
export interface PersistentWorkflowAgentDef<TPayload = unknown> {
  /** Backend id, resolved like an `agent()` step's `backend`. */
  backend?: string
  model?: string
  /** System prompt prepended to every turn. */
  system?: string
  /**
   * Path to a directory holding `AGENTS.md` (required) + optional `SOUL.md`,
   * resolved against the workflow file's directory. Loaded and threaded to the
   * terminal turn each fire, same as an `agent()` step's `agentDef`.
   */
  agentDef?: string
  /**
   * `extend` (default) keeps skelm's built-in default sections; `replace` drops
   * them and uses only AGENTS.md/SOUL.md + `system`. Mirrors `agent()`.
   */
  systemPromptMode?: 'extend' | 'replace'
  /** When `systemPromptMode === 'replace'`, still inject AGENTS.md/SOUL.md (default true). */
  systemPromptIncludeAgentDef?: boolean
  /**
   * Permissions for the terminal turn. MAY set `requestUnrestricted: true` to
   * ask for a full bypass — inert unless the operator also grants this
   * workflow's id in gateway config. Applies ONLY to the terminal turn;
   * preamble steps carry their own permissions and stay default-deny. See
   * `docs/concepts/permissions.md`.
   */
  permissions?: AgentPermissions
  /** Max agent turns per fire. */
  maxTurns?: number
  /**
   * Maps a trigger payload to a stable conversation key — e.g. a Telegram
   * `chatId`, so each chat is its own durable session. Required: it is what
   * makes the workflow "persistent" per conversation rather than per fire.
   * Resolved up front from the trigger payload, before any step runs.
   */
  sessionKey: (payload: TPayload) => string
  /**
   * Derives the user's message text for the terminal turn from the full run
   * context — `ctx.input` (the trigger payload) plus any preamble step outputs
   * in `ctx.steps`. Default: `payload.text`.
   */
  prompt?: (ctx: Context<TPayload>) => string | Promise<string>
  /** Shapes the reply object a queue driver's `onResult` posts. Default: `{ reply: text }`. */
  reply?: (text: string) => unknown
}

/** Author-facing definition of a persistent workflow. */
export interface PersistentWorkflowDef<TPayload = unknown> {
  /** Stable id. Used as the trigger `workflowId` and the session namespace key. */
  id: string
  description?: string
  /** Triggers that drive fires (same shape as `pipeline().triggers`). */
  triggers?: readonly PipelineTrigger[]
  /**
   * Optional preamble steps run FRESH each fire (not persistent). They enrich or
   * transform the incoming message before the terminal turn; their outputs are
   * visible to `agent.prompt` via `ctx.steps`. No preamble step may use the
   * reserved id `'turn'`.
   */
  steps?: readonly Step[]
  /** The persistent terminal agent. The workflow always ends here. */
  agent: PersistentWorkflowAgentDef<TPayload>
}

/** A frozen persistent-workflow value. The `kind` discriminator distinguishes it
 *  from a `Pipeline` (which also has `steps`) at dispatch time. */
export interface PersistentWorkflow<TPayload = unknown>
  extends Readonly<PersistentWorkflowDef<TPayload>> {
  readonly kind: 'persistent-workflow'
}

/** Type guard used by the gateway dispatcher to route a fire to a turn runner. */
export function isPersistentWorkflow(value: unknown): value is PersistentWorkflow {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'persistent-workflow'
  )
}

/**
 * Author a persistent workflow. Returns a plain immutable value; the gateway
 * hosts it and runs one enforced turn (preceded by any preamble steps) per
 * trigger fire.
 */
export function persistentWorkflow<TPayload = unknown>(
  def: PersistentWorkflowDef<TPayload>,
): PersistentWorkflow<TPayload> {
  if (!def.id) {
    throw new Error('persistentWorkflow(): id is required')
  }
  if (typeof def.agent?.sessionKey !== 'function') {
    throw new Error(`persistentWorkflow(${def.id}): agent.sessionKey must be a function`)
  }
  for (const step of def.steps ?? []) {
    if (step.id === PERSISTENT_TURN_STEP_ID) {
      throw new Error(
        `persistentWorkflow(${def.id}): preamble step id '${PERSISTENT_TURN_STEP_ID}' is reserved for the terminal turn`,
      )
    }
  }
  const out: PersistentWorkflow<TPayload> = {
    kind: 'persistent-workflow',
    id: def.id,
    agent: Object.freeze({ ...def.agent }),
    ...(def.description !== undefined && { description: def.description }),
    ...(def.steps !== undefined && { steps: Object.freeze([...def.steps]) }),
    ...(def.triggers !== undefined && {
      triggers: Object.freeze(def.triggers.map((t) => normalizePipelineTrigger(def.id, t))),
    }),
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
