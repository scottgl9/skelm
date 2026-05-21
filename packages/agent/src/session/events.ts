/**
 * Event types emitted by an AgentSession. Deliberately narrower than what
 * an interactive UI would need: only events a pipeline observer cares about
 * (the model produced something, a tool ran, the turn ended).
 */

import type { SessionMessage } from './messages.js'

export interface SessionPromptResult {
  text: string
  stopReason: 'stop' | 'length' | 'tool' | 'error' | 'aborted'
  usage?: { inputTokens: number; outputTokens: number }
}

export type SessionEvent =
  | { type: 'message_complete'; message: SessionMessage }
  | {
      type: 'tool_call'
      callId: string
      name: string
      args: unknown
    }
  | {
      type: 'tool_result'
      callId: string
      name: string
      content: string
      isError: boolean
    }
  | { type: 'agent_end'; result: SessionPromptResult }
  | {
      // Emitted only when the caller opts in with `streamDeltas: true`. Pipelines
      // should not subscribe to this — it bloats the run store. Useful when
      // piping to a UI that wants live text.
      type: 'message_delta'
      text: string
    }

export type SessionEventListener = (event: SessionEvent) => void

export type Unsubscribe = () => void
