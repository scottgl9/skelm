// Durable per-session persistence for persistent workflows. Backed by the run
// store's StateStore — no new store type. One record per (workflowId, sessionKey),
// holding the serialized conversation plus a stable sessionId threaded into
// AgentRequest.sessionId and the agentmemory session lifecycle so resumption-
// capable backends pick up where they left off across fires and restarts.

import type { StateStore } from './run-store.js'

/** StateStore namespace owning all persistent-workflow session records. */
export const PERSISTENT_WORKFLOW_NAMESPACE = 'persistent-workflow'

/**
 * A durable conversation session. `conversation` holds whatever the turn runner
 * serializes (e.g. `AgentSession.toJSON()`); it is opaque here so core never
 * depends on a backend package.
 */
export interface PersistentSessionRecord {
  version: 1
  workflowId: string
  sessionKey: string
  /** Stable across fires; fed to AgentRequest.sessionId + agentmemory.startSession. */
  sessionId: string
  /** Backend-serialized conversation, or undefined before the first turn. */
  conversation: unknown
  /** Turns run so far in this session. */
  turns: number
  createdAt: number
  updatedAt: number
  /**
   * Advisory lock acquired by `acquireSession()` and released by
   * `releaseSession()`. Cross-process: persisted into the StateStore via
   * compare-and-swap so two gateway replicas can't run concurrent turns
   * for the same (workflowId, sessionKey) and overwrite each other's
   * conversation history. Within a single process, `withSessionLock`
   * still serializes locally — this lock is the multi-process safety net.
   */
  active?: { ownerId: string; since: number }
}

/** Thrown when a turn dispatch tries to enter a session another owner holds. */
export class PersistentSessionLockedError extends Error {
  override readonly name = 'PersistentSessionLockedError'
  constructor(
    readonly workflowId: string,
    readonly sessionKey: string,
    readonly heldBy: string,
  ) {
    super(
      `persistent-workflow session is held by another owner (workflow=${workflowId}, sessionKey=${sessionKey}, owner=${heldBy})`,
    )
  }
}

function stateKey(workflowId: string, sessionKey: string): string {
  return `${workflowId}::${sessionKey}`
}

/** Build a fresh session record with a new stable sessionId. */
export function createSessionRecord(
  workflowId: string,
  sessionKey: string,
): PersistentSessionRecord {
  const now = Date.now()
  return {
    version: 1,
    workflowId,
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
  workflowId: string,
  sessionKey: string,
): Promise<PersistentSessionRecord | undefined> {
  return store.getState<PersistentSessionRecord>(
    PERSISTENT_WORKFLOW_NAMESPACE,
    stateKey(workflowId, sessionKey),
  )
}

/** Persist a session record (sets `updatedAt`). */
export async function saveSession(store: StateStore, rec: PersistentSessionRecord): Promise<void> {
  const next: PersistentSessionRecord = { ...rec, updatedAt: Date.now() }
  await store.setState(
    PERSISTENT_WORKFLOW_NAMESPACE,
    stateKey(rec.workflowId, rec.sessionKey),
    next,
  )
}

/**
 * Acquire the session's advisory lock for the given owner. Atomic via
 * StateStore.casState: returns the locked record on success, or throws
 * PersistentSessionLockedError when another owner already holds it.
 *
 * Re-entrant for the same `ownerId` (same owner can reacquire without
 * error — supports retry on transient client failure). Lock entries are
 * advisory and survive process death; operators recovering a stuck
 * session can clear `active` manually if a dispatcher truly died mid-turn
 * without releasing.
 */
export async function acquireSession(
  store: StateStore,
  workflowId: string,
  sessionKey: string,
  ownerId: string,
): Promise<PersistentSessionRecord> {
  const key = stateKey(workflowId, sessionKey)
  const current = await store.getState<PersistentSessionRecord>(PERSISTENT_WORKFLOW_NAMESPACE, key)
  if (current?.active !== undefined && current.active.ownerId !== ownerId) {
    throw new PersistentSessionLockedError(workflowId, sessionKey, current.active.ownerId)
  }
  const base: PersistentSessionRecord = current ?? createSessionRecord(workflowId, sessionKey)
  const next: PersistentSessionRecord = {
    ...base,
    active: { ownerId, since: Date.now() },
    updatedAt: Date.now(),
  }
  const ok = await store.casState(PERSISTENT_WORKFLOW_NAMESPACE, key, current, next)
  if (!ok) {
    // Someone else won the race between getState and casState.
    const refreshed = await store.getState<PersistentSessionRecord>(
      PERSISTENT_WORKFLOW_NAMESPACE,
      key,
    )
    const heldBy = refreshed?.active?.ownerId ?? 'unknown'
    throw new PersistentSessionLockedError(workflowId, sessionKey, heldBy)
  }
  return next
}

/** Release the advisory lock — no-op if the caller doesn't hold it. */
export async function releaseSession(
  store: StateStore,
  workflowId: string,
  sessionKey: string,
  ownerId: string,
): Promise<void> {
  const key = stateKey(workflowId, sessionKey)
  const current = await store.getState<PersistentSessionRecord>(PERSISTENT_WORKFLOW_NAMESPACE, key)
  if (current === undefined) return
  if (current.active?.ownerId !== ownerId) return
  const { active: _, ...rest } = current
  const next: PersistentSessionRecord = { ...rest, updatedAt: Date.now() }
  await store.setState(PERSISTENT_WORKFLOW_NAMESPACE, key, next)
}
