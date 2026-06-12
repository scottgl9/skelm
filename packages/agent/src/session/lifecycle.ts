/**
 * Session lifecycle verbs over any SessionStore.
 *
 * These are store-agnostic helpers, not new interface methods — every
 * existing SessionStore implementation (file, in-memory, custom) gets
 * fork / export / import for free, with no breaking interface change.
 * `list()` / `delete()` already live on the store itself, and the
 * compact/summarize path (`shouldCompact` / `compact`) completes the
 * documented lifecycle.
 */

import { BackendSessionError } from '@skelm/core'

import type { SerializedSession } from './agent-session.js'
import type { MessageRole } from './messages.js'
import type { SessionStore } from './store/types.js'

const VALID_ROLES: ReadonlySet<string> = new Set<MessageRole>([
  'system',
  'user',
  'assistant',
  'tool',
])

/**
 * Validate an untrusted value as a SerializedSession. Import is a system
 * boundary — sessions arrive as external JSON (uploads, copies between
 * machines), so shape is checked before anything is persisted.
 */
export function assertSerializedSession(value: unknown): SerializedSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BackendSessionError('serialized session must be an object')
  }
  const v = value as Record<string, unknown>
  if (v.version !== 1) {
    throw new BackendSessionError(`unsupported SerializedSession version: ${String(v.version)}`)
  }
  if (!Array.isArray(v.messages)) {
    throw new BackendSessionError('serialized session is missing a messages array')
  }
  for (const [i, m] of v.messages.entries()) {
    if (typeof m !== 'object' || m === null) {
      throw new BackendSessionError(`serialized session message ${i} is not an object`)
    }
    const msg = m as Record<string, unknown>
    if (typeof msg.role !== 'string' || !VALID_ROLES.has(msg.role)) {
      throw new BackendSessionError(`serialized session message ${i} has invalid role`)
    }
    if (typeof msg.content !== 'string') {
      throw new BackendSessionError(`serialized session message ${i} has non-string content`)
    }
  }
  return value as SerializedSession
}

/**
 * Copy (fork / clone) the session stored under `sourceId` to `targetId`.
 * Both sessions exist independently afterwards; mutating one never touches
 * the other. Returns the forked snapshot. Throws `BackendSessionError` when
 * the source does not exist.
 */
export async function forkSession(
  store: SessionStore,
  sourceId: string,
  targetId: string,
): Promise<SerializedSession> {
  const source = await store.load(sourceId)
  if (source === undefined) {
    throw new BackendSessionError(`cannot fork: session "${sourceId}" not found`)
  }
  await store.save(targetId, source)
  return source
}

/**
 * Export the session stored under `id` as its portable SerializedSession.
 * Throws `BackendSessionError` when the session does not exist — use
 * `store.load()` directly if absence is an expected outcome.
 */
export async function exportSession(store: SessionStore, id: string): Promise<SerializedSession> {
  const session = await store.load(id)
  if (session === undefined) {
    throw new BackendSessionError(`cannot export: session "${id}" not found`)
  }
  return session
}

/**
 * Import an externally produced SerializedSession (e.g. the output of
 * `exportSession` on another machine) under `id`. The payload is validated
 * before it is persisted; an existing session under `id` is overwritten.
 * Returns the validated session.
 */
export async function importSession(
  store: SessionStore,
  id: string,
  session: unknown,
): Promise<SerializedSession> {
  const validated = assertSerializedSession(session)
  await store.save(id, validated)
  return validated
}
