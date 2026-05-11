/**
 * Combine any number of AbortSignals into one that aborts when any input
 * aborts. Thin wrapper over `AbortSignal.any` — present so backends don't each
 * re-implement the same null-filtering glue.
 */
export function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined)
  if (present.length === 0) return new AbortController().signal
  if (present.length === 1) return present[0] as AbortSignal
  return AbortSignal.any(present)
}

/**
 * Create an AbortSignal that fires after `ms` milliseconds. Returns the
 * underlying controller so callers can clear the timer when the surrounding
 * work finishes early (avoiding a dangling timeout).
 */
export function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(new Error(`timed out after ${ms}ms`)), ms)
  return {
    signal: ctl.signal,
    clear: () => clearTimeout(timer),
  }
}
