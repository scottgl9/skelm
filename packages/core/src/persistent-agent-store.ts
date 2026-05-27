// Durable per-session persistence for persistent agents. Backed by the run
// store's StateStore — no new store type. One record per (agentId, sessionKey),
// holding the serialized conversation plus a stable sessionId threaded into
// AgentRequest.sessionId and the agentmemory session lifecycle so resumption-
// capable backends pick up where they left off across fires and restarts.

import type { StateStore } from './run-store.js'

/** StateStore namespace owning all persistent-agent session records. */
export const PERSISTENT_AGENT_NAMESPACE = 'persistent-agent'

/**
 * A durable conversation session. `conversation` holds whatever the turn runner
 * serializes (e.g. `AgentSession.toJSON()`); it is opaque here so core never
 * depends on a backend package.
 */
export interface PersistentSessionRecord {
  version: 1
  agentId: string
  sessionKey: string
  /** Stable across fires; fed to AgentRequest.sessionId + agentmemory.startSession. */
  sessionId: string
  /** Backend-serialized conversation, or undefined before the first turn. */
  conversation: unknown
  /** Turns run so far in this session. */
  turns: number
  createdAt: number
  updatedAt: number
}

function stateKey(agentId: string, sessionKey: string): string {
  return `${agentId}::${sessionKey}`
}

/** Build a fresh session record with a new stable sessionId. */
export function createSessionRecord(agentId: string, sessionKey: string): PersistentSessionRecord {
  const now = Date.now()
  return {
    version: 1,
    agentId,
    sessionKey,
    sessionId: crypto.randomUUID(),
    conversation: undefined,
    turns: 0,
    createdAt: now,
    updatedAt: now,
  }
}

/** Load the durable session for a conversation key, or undefined if none yet. */
export async function loadSession(
  store: StateStore,
  agentId: string,
  sessionKey: string,
): Promise<PersistentSessionRecord | undefined> {
  return store.getState<PersistentSessionRecord>(
    PERSISTENT_AGENT_NAMESPACE,
    stateKey(agentId, sessionKey),
  )
}

/** Persist a session record (sets `updatedAt`). */
export async function saveSession(store: StateStore, rec: PersistentSessionRecord): Promise<void> {
  const next: PersistentSessionRecord = { ...rec, updatedAt: Date.now() }
  await store.setState(PERSISTENT_AGENT_NAMESPACE, stateKey(rec.agentId, rec.sessionKey), next)
}
