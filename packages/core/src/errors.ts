import type { SerializedError } from './types-base.js'

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

/** Thrown when invoke() cannot find a pipeline by its registered ID. */
export class InvokePipelineNotFoundError extends Error {
  override readonly name = 'InvokePipelineNotFoundError'
  readonly pipelineId: string
  readonly stepId: string
  constructor(pipelineId: string, stepId: string) {
    super(`invoke(${stepId}): pipeline "${pipelineId}" not found in registry`)
    this.pipelineId = pipelineId
    this.stepId = stepId
  }
}

/** Thrown when a permission check blocks a privileged action. */
export class PermissionDeniedError extends Error {
  override readonly name = 'PermissionDeniedError'
}

/** Thrown when an agent step's approval gate rejects the run. */
export class ApprovalDeniedError extends Error {
  constructor(
    readonly stepId: string,
    readonly approver?: string,
    readonly reason?: string,
  ) {
    super(`approval denied for step "${stepId}"${reason ? `: ${reason}` : ''}`)
    this.name = 'ApprovalDeniedError'
  }
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

/** Thrown when runStep encounters an unrecognized step kind (exhaustiveness break). */
export class StepKindError extends Error {
  override readonly name = 'StepKindError'
  constructor(readonly kind: string) {
    super(`unknown step kind: ${kind}`)
  }
}

/** Thrown when a branch() step's discriminator matches no case and no default. */
export class BranchExhaustionError extends Error {
  override readonly name = 'BranchExhaustionError'
  constructor(
    readonly stepId: string,
    readonly key: string,
  ) {
    super(`branch(${stepId}): no case matched "${key}" and no default was provided`)
  }
}

/** Thrown when ctx.exec() is invoked with an invalid command/python/bash combination. */
export class ExecConfigError extends Error {
  override readonly name = 'ExecConfigError'
}

/** Thrown when a workflow asset path is invalid or cannot be read from its asset root. */
export class AssetPathError extends Error {
  override readonly name = 'AssetPathError'
  override readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

/** Thrown when Runner.resume() or awaitResume() is called against an illegal run state. */
export class RunStateError extends Error {
  override readonly name = 'RunStateError'
  readonly runId: string
  constructor(runId: string, message: string) {
    super(message)
    this.runId = runId
  }
}

/** Thrown when a durable state handle is configured with an invalid scope. */
export class StateConfigError extends Error {
  override readonly name = 'StateConfigError'
}

/** Thrown when a wait() step runs without a waitForInput handler wired by the runner. */
export class WaitConfigError extends Error {
  override readonly name = 'WaitConfigError'
  constructor(readonly stepId: string) {
    super(
      `wait(${stepId}): no wait handler configured; use Runner.start() or pass waitForInput to runPipeline()`,
    )
  }
}

/**
 * Default cap on how deep a chain of agent-to-agent delegations may go before
 * the runtime refuses further hand-offs. Bounds resource use on a runaway
 * router; gateways may override via config.
 */
export const DEFAULT_MAX_DELEGATION_DEPTH = 8

/** Thrown when a delegation would revisit a pipeline already on the active chain. */
export class DelegationCycleError extends Error {
  override readonly name = 'DelegationCycleError'
  readonly targetId: string
  readonly chain: readonly string[]
  constructor(targetId: string, chain: readonly string[]) {
    super(
      `delegation cycle: "${targetId}" is already on the delegation chain [${chain.join(' -> ')}]`,
    )
    this.targetId = targetId
    this.chain = chain
  }
}

/** Thrown when a delegation would exceed the maximum delegation depth. */
export class DelegationDepthError extends Error {
  override readonly name = 'DelegationDepthError'
  readonly targetId: string
  readonly depth: number
  readonly maxDepth: number
  constructor(targetId: string, depth: number, maxDepth: number) {
    super(
      `delegation to "${targetId}" rejected: depth ${depth} would exceed the maximum of ${maxDepth}`,
    )
    this.targetId = targetId
    this.depth = depth
    this.maxDepth = maxDepth
  }
}

/** Thrown when a registry operation violates uniqueness or lookup invariants. */
export class RegistryError extends Error {
  override readonly name = 'RegistryError'
  constructor(
    message: string,
    readonly registry: string,
    readonly id?: string,
  ) {
    super(message)
  }
}

/** Thrown when a static framework configuration is malformed. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError'
  constructor(
    message: string,
    readonly scope?: string,
  ) {
    super(message)
  }
}

/** Return a stable, human-readable message for any thrown value. */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    const serialized = JSON.stringify(err)
    return serialized === undefined ? String(err) : serialized
  } catch {
    return String(err)
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
    message: toErrorMessage(err),
  }
}
