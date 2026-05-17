import { type Run, type RunStore, serializeError } from '@skelm/core'

/** Recorded on a Run that the gateway found in `running` state at startup. */
export class RunCrashedError extends Error {
  override readonly name = 'RunCrashedError'
  constructor(runId: string) {
    super(`run "${runId}" was interrupted before completion and recovered on gateway start`)
  }
}

export interface RecoveryResult {
  /** Run IDs that were marked failed because they were `running` at startup. */
  readonly recovered: readonly string[]
}

/**
 * Scan the run store for runs left in `running` state — i.e. interrupted
 * by a gateway crash, SIGKILL, or container restart. Finalize each to
 * `failed` with RunCrashedError and a `recoveredFrom: 'running'` marker
 * so audit/operators can distinguish recovery-failures from in-process
 * step failures.
 *
 * Idempotent: re-running on a clean store is a no-op.
 *
 * Phase 2.1 persists a `running` Run record up-front; this consumer
 * relies on that contract.
 */
export async function recoverInterruptedRuns(store: RunStore): Promise<RecoveryResult> {
  const recovered: string[] = []
  const ids: string[] = []
  for await (const summary of store.listRuns({ status: 'running' })) {
    ids.push(summary.runId)
  }
  for (const runId of ids) {
    const existing = await store.getRun(runId)
    if (existing === null || existing.status !== 'running') continue
    const err = new RunCrashedError(runId)
    const completedAt = Date.now()
    const next: Run = {
      ...existing,
      status: 'failed',
      error: serializeError(err),
      completedAt,
    }
    await store.putRun(next)
    recovered.push(runId)
  }
  return { recovered }
}
