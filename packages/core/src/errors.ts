import type { SerializedError } from './types.js'

/** Thrown when a step handler throws an error not otherwise typed. */
export class StepError extends Error {
  override readonly name = 'StepError'
  readonly stepId: string
  override readonly cause?: unknown
  constructor(message: string, stepId: string, cause?: unknown) {
    super(message)
    this.stepId = stepId
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

/** Thrown when a run is cancelled via its AbortSignal. */
export class RunCancelledError extends Error {
  override readonly name = 'RunCancelledError'
  constructor(message = 'run was cancelled') {
    super(message)
  }
}

/** Thrown when a wait() step does not receive resume input before its timeout. */
export class WaitTimeoutError extends Error {
  override readonly name = 'WaitTimeoutError'
  constructor(message = 'wait step timed out') {
    super(message)
  }
}

/** Thrown when a permission check blocks a privileged action. */
export class PermissionDeniedError extends Error {
  override readonly name = 'PermissionDeniedError'
}

/** Thrown when an agent step exceeds its declared `timeoutMs` wall clock. */
export class StepTimeoutError extends Error {
  override readonly name = 'StepTimeoutError'
  constructor(
    readonly stepId: string,
    readonly timeoutMs: number,
  ) {
    super(`step "${stepId}" exceeded its ${timeoutMs}ms timeout`)
  }
}

/** Convert any thrown value to the serializable error shape we record. */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...(err.stack !== undefined && { stack: err.stack }),
    }
  }
  return {
    name: 'NonError',
    message: typeof err === 'string' ? err : JSON.stringify(err),
  }
}
