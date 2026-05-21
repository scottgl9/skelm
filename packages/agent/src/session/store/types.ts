import type { SerializedSession } from '../agent-session.js'

/**
 * Pluggable persistence for serialized sessions. Pipelines using skelm's
 * run store get persistence for free — this interface exists for callers
 * that want to maintain sessions outside the gateway (e.g. local scripts).
 */
export interface SessionStore {
  save(id: string, session: SerializedSession): Promise<void>
  load(id: string): Promise<SerializedSession | undefined>
  list(): Promise<string[]>
  delete(id: string): Promise<boolean>
}
