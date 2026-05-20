// Postgres RunStore — M4 seam.
//
// Reserves the public shape so the eventual driver lands as a pure
// addition rather than an interface migration. Every method throws
// NotImplementedError; production callers should keep using
// SqliteRunStore (default) or MemoryRunStore (tests).
//
// The intent of this seam is twofold:
// 1. Lock in the constructor signature (`new PostgresRunStore({ url })`)
//    so consumers can wire it conditionally before the driver lands.
// 2. Let the existing RunStore contract test exercise the typed shape
//    inside a `.skip` block (see packages/core/test/run-store-postgres.contract.test.ts)
//    so a refactor of the RunStore interface surfaces here at typecheck
//    time, not at M4 implementation time.

import type { RunEvent } from './events.js'
import type {
  ArtifactDescriptor,
  ArtifactRef,
  AuditEntry,
  RunFilter,
  RunStore,
  RunSummary,
} from './run-store.js'
import type { Run, RunId, StateEntry, StateReadOptions, StateSetOptions } from './types.js'

export interface PostgresRunStoreOptions {
  /** Connection URL, e.g. postgres://user:pass@host:5432/db. */
  readonly url: string
  /**
   * Optional schema name for the runs / events / state / audit tables.
   * Defaults to `public`. Reserved on the seam so the M4 driver doesn't
   * have to break callers that already pass this.
   */
  readonly schema?: string
  /**
   * Pool size hint. The M4 driver will use a connection pool; reserving
   * the option here keeps the constructor stable.
   */
  readonly poolSize?: number
}

export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError'
  constructor(method: string) {
    super(`PostgresRunStore.${method}() is reserved for M4 — use SqliteRunStore for now`)
  }
}

/**
 * @experimental Reserved skeleton for the M4 Postgres driver. Throws
 * NotImplementedError on every method. Do not depend on this in
 * production code.
 */
export class PostgresRunStore implements RunStore {
  constructor(readonly options: PostgresRunStoreOptions) {
    void this.options
  }

  async putRun(_run: Run): Promise<void> {
    throw new NotImplementedError('putRun')
  }
  async updateRun(_runId: RunId, _patch: Partial<Run>): Promise<void> {
    throw new NotImplementedError('updateRun')
  }
  async getRun(_runId: RunId): Promise<Run | null> {
    throw new NotImplementedError('getRun')
  }
  // biome-ignore lint/correctness/useYield: skeleton method body unreachable
  async *listRuns(_filter?: RunFilter): AsyncIterable<RunSummary> {
    throw new NotImplementedError('listRuns')
  }
  async appendEvent(_event: RunEvent): Promise<void> {
    throw new NotImplementedError('appendEvent')
  }
  // biome-ignore lint/correctness/useYield: skeleton method body unreachable
  async *listEvents(
    _runId: RunId,
    _opts?: { since?: number; limit?: number },
  ): AsyncIterable<RunEvent> {
    throw new NotImplementedError('listEvents')
  }
  async getState<T>(_namespace: string, _key: string): Promise<T | undefined> {
    throw new NotImplementedError('getState')
  }
  async setState<T>(
    _namespace: string,
    _key: string,
    _value: T,
    _opts?: StateSetOptions,
  ): Promise<void> {
    throw new NotImplementedError('setState')
  }
  async deleteState(_namespace: string, _key: string): Promise<void> {
    throw new NotImplementedError('deleteState')
  }
  // biome-ignore lint/correctness/useYield: skeleton method body unreachable
  async *listState(_namespace: string, _prefix?: string): AsyncIterable<StateEntry> {
    throw new NotImplementedError('listState')
  }
  async casState<T>(
    _namespace: string,
    _key: string,
    _expected: T | undefined,
    _next: T,
  ): Promise<boolean> {
    throw new NotImplementedError('casState')
  }
  async appendState(_namespace: string, _stream: string, _entry: unknown): Promise<void> {
    throw new NotImplementedError('appendState')
  }
  // biome-ignore lint/correctness/useYield: skeleton method body unreachable
  async *readState(
    _namespace: string,
    _stream: string,
    _opts?: StateReadOptions,
  ): AsyncIterable<unknown> {
    throw new NotImplementedError('readState')
  }
  async putAudit(_entry: AuditEntry): Promise<void> {
    throw new NotImplementedError('putAudit')
  }
  async putArtifact(_opts: {
    runId: RunId
    stepId?: string
    name: string
    mimeType: string
    data: Uint8Array | string
  }): Promise<ArtifactDescriptor> {
    throw new NotImplementedError('putArtifact')
  }
  async getArtifact(
    _ref: ArtifactRef,
  ): Promise<{ descriptor: ArtifactDescriptor; data: Uint8Array } | null> {
    throw new NotImplementedError('getArtifact')
  }
  // biome-ignore lint/correctness/useYield: skeleton method body unreachable
  async *listArtifacts(
    _runId: RunId,
    _opts?: { stepId?: string },
  ): AsyncIterable<ArtifactDescriptor> {
    throw new NotImplementedError('listArtifacts')
  }
}
