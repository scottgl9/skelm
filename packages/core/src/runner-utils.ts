/**
 * Pure-leaf helpers used by the pipeline runner. Lifted out of runner.ts
 * so the orchestrator file stays focused on actual step execution.
 */

import { RunCancelledError, WaitTimeoutError } from './errors.js'
import type { AgentPermissions } from './permissions.js'
import type { Context, Run, StepResult } from './types.js'

export function freezeContext<TInput>(ctx: Context<TInput>): Context<TInput> {
  Object.freeze(ctx.steps)
  return Object.freeze(ctx)
}

export function adoptLastStepOutput<TOutput>(
  stepResults: readonly StepResult[],
): TOutput | undefined {
  if (stepResults.length === 0) return undefined
  return stepResults[stepResults.length - 1]?.output as TOutput | undefined
}

export function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}

export function applyWorkspacePermissions(
  permissions: AgentPermissions | undefined,
  workspacePath: string | undefined,
): AgentPermissions | undefined {
  if (workspacePath === undefined) return permissions
  return {
    ...permissions,
    fsRead: uniqueStrings([workspacePath, ...(permissions?.fsRead ?? [])]),
    fsWrite: uniqueStrings([workspacePath, ...(permissions?.fsWrite ?? [])]),
  }
}

export function resolveIdempotentKey(
  key: string | ((ctx: Context) => string),
  ctx: Context,
): string {
  const resolved = typeof key === 'function' ? key(ctx) : key
  if (resolved.trim().length === 0) {
    throw new Error('idempotent(): key must resolve to a non-empty string')
  }
  return resolved
}

export function idempotentStateKey(key: string): string {
  return `idempotent:${key}`
}

export function generateRunId(): string {
  return crypto.randomUUID()
}

export function restoreSerializedError(error: Run['error'], fallbackMessage: string): Error {
  const restored = new Error(error?.message ?? fallbackMessage)
  restored.name = error?.name ?? 'Error'
  if (error?.stack !== undefined) {
    restored.stack = error.stack
  }
  return restored
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof RunCancelledError || err instanceof WaitTimeoutError) return false
  if (err instanceof Error) {
    return err.name !== RunCancelledError.name && err.name !== WaitTimeoutError.name
  }
  return true
}

export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new RunCancelledError()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new RunCancelledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer.unref?.()
  })
}
