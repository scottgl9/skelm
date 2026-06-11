import type { RunStore } from '../run-store.js'
import type { Run } from '../types.js'

export function bindAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController,
): (() => void) | undefined {
  if (signal === undefined) return undefined
  if (signal.aborted) {
    controller.abort(signal.reason)
    return undefined
  }

  const abortHandler = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abortHandler, { once: true })
  return () => signal.removeEventListener('abort', abortHandler)
}

export async function finalizeStoredRun<TRun extends Run>(
  run: TRun,
  store: RunStore | undefined,
  storeWrites: Promise<void>[],
  unsubscribeStore: (() => void) | undefined,
  auditWrites: Promise<void>[] = [],
  unsubscribeAbort?: () => void,
  unsubscribeRunState?: () => void,
  unsubscribeAudit?: () => void,
  unsubscribeOnEvent?: () => void,
): Promise<TRun> {
  try {
    await Promise.all(storeWrites)
    await Promise.all(auditWrites)
    await store?.putRun(run)
    return run
  } finally {
    unsubscribeStore?.()
    unsubscribeRunState?.()
    unsubscribeAudit?.()
    unsubscribeOnEvent?.()
    unsubscribeAbort?.()
  }
}
