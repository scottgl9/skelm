import type { Pipeline, Step } from '@skelm/core'
import { EXIT, type ExitCode } from './exit-codes.js'
import { CliError, loadWorkflowFromFile } from './load-workflow.js'

/**
 * Static workflow + permission preflight. Read-only; never executes a step.
 *
 * The checks here surface what default-deny would *eventually* surface at
 * runtime — the point is to catch them in CI and pre-commit, before any LLM
 * call, agent spawn, or side effect.
 */

export interface ValidateCommandArgs {
  path: string
  json?: boolean
}

export interface ValidateCommandIO {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

export interface ValidateCommandResult {
  exitCode: ExitCode
}

export interface ValidationIssue {
  /** Dot path inside the pipeline that names the offender (e.g. "steps[2].agent#review.permissions"). */
  readonly at: string
  /** Stable code suitable for filtering in CI. */
  readonly code: ValidationCode
  /** Human-readable explanation. */
  readonly message: string
}

export type ValidationCode =
  | 'load-failed'
  | 'no-default-export'
  | 'pipeline-id-missing'
  | 'pipeline-empty'
  | 'duplicate-step-id'
  | 'agent-missing-permissions'
  | 'agent-secret-name-empty'
  | 'agent-secret-name-shape'
  | 'branch-no-cases'
  | 'parallel-empty'
  | 'pipeline-step-missing'
  | 'unknown-step-kind'

export async function validateCommand(
  args: ValidateCommandArgs,
  io: ValidateCommandIO,
): Promise<ValidateCommandResult> {
  const issues: ValidationIssue[] = []
  let pipeline: Pipeline | undefined
  try {
    pipeline = await loadWorkflowFromFile(args.path)
  } catch (err) {
    const code: ValidationCode =
      err instanceof CliError && err.code === 'workflow-invalid'
        ? 'no-default-export'
        : 'load-failed'
    issues.push({
      at: args.path,
      code,
      message: err instanceof Error ? err.message : String(err),
    })
    return finish(args, io, issues)
  }

  if (!pipeline.id || pipeline.id.length === 0) {
    issues.push({
      at: 'pipeline.id',
      code: 'pipeline-id-missing',
      message: 'pipeline.id is required',
    })
  }
  if (!pipeline.steps || pipeline.steps.length === 0) {
    issues.push({ at: 'pipeline.steps', code: 'pipeline-empty', message: 'pipeline has no steps' })
    return finish(args, io, issues)
  }

  walkSteps(pipeline.steps, 'pipeline', issues, new Set<string>())
  return finish(args, io, issues)
}

function walkSteps(
  steps: readonly Step[],
  scope: string,
  issues: ValidationIssue[],
  seenInScope: Set<string>,
): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (!step) continue
    const at = `${scope}.steps[${i}]#${step.id ?? '?'}`
    if (step.id && seenInScope.has(step.id)) {
      issues.push({
        at,
        code: 'duplicate-step-id',
        message: `step id "${step.id}" is duplicated within ${scope}`,
      })
    } else if (step.id) {
      seenInScope.add(step.id)
    }
    inspectStep(step, at, issues)
  }
}

function inspectStep(step: Step, at: string, issues: ValidationIssue[]): void {
  switch (step.kind) {
    case 'agent': {
      if (!step.permissions) {
        issues.push({
          at: `${at}.permissions`,
          code: 'agent-missing-permissions',
          message:
            'agent step has no permissions{} declared; default-deny will block every privileged action at runtime',
        })
      }
      if (step.secrets) {
        for (let i = 0; i < step.secrets.length; i++) {
          const name = step.secrets[i]
          if (!name) {
            issues.push({
              at: `${at}.secrets[${i}]`,
              code: 'agent-secret-name-empty',
              message: 'secret name is empty',
            })
            continue
          }
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            issues.push({
              at: `${at}.secrets[${i}]`,
              code: 'agent-secret-name-shape',
              message: `secret name "${name}" does not look like an env-var identifier`,
            })
          }
        }
      }
      return
    }
    case 'parallel': {
      if (!step.steps || step.steps.length === 0) {
        issues.push({
          at: `${at}.steps`,
          code: 'parallel-empty',
          message: 'parallel has no children',
        })
        return
      }
      walkSteps(step.steps, at, issues, new Set<string>())
      return
    }
    case 'branch': {
      const keys = Object.keys(step.cases ?? {})
      if (keys.length === 0) {
        issues.push({ at: `${at}.cases`, code: 'branch-no-cases', message: 'branch has no cases' })
        return
      }
      for (const k of keys) {
        const child = step.cases[k]
        if (child) inspectStep(child, `${at}.cases.${k}`, issues)
      }
      if (step.default) inspectStep(step.default, `${at}.default`, issues)
      return
    }
    case 'loop': {
      if (step.step) inspectStep(step.step, `${at}.step`, issues)
      return
    }
    case 'forEach': {
      // step factory body is opaque without runtime context — nothing to check here.
      return
    }
    case 'pipelineStep': {
      if (
        !step.pipeline ||
        !Array.isArray(step.pipeline.steps) ||
        step.pipeline.steps.length === 0
      ) {
        issues.push({
          at: `${at}.pipeline`,
          code: 'pipeline-step-missing',
          message: 'pipelineStep references an empty or missing pipeline',
        })
        return
      }
      walkSteps(step.pipeline.steps, `${at}.pipeline`, issues, new Set<string>())
      return
    }
    case 'idempotent': {
      if (step.step) inspectStep(step.step, `${at}.step`, issues)
      return
    }
    case 'code':
    case 'llm':
    case 'wait':
      return
    default: {
      issues.push({
        at,
        code: 'unknown-step-kind',
        message: `unknown step kind: ${(step as { kind?: string }).kind ?? '?'}`,
      })
    }
  }
}

function finish(
  args: ValidateCommandArgs,
  io: ValidateCommandIO,
  issues: ValidationIssue[],
): ValidateCommandResult {
  if (args.json) {
    io.stdout.write(`${JSON.stringify({ ok: issues.length === 0, issues }, null, 2)}\n`)
  } else if (issues.length === 0) {
    io.stdout.write(`ok: ${args.path} validates\n`)
  } else {
    io.stderr.write(
      `error: ${issues.length} issue${issues.length === 1 ? '' : 's'} in ${args.path}\n`,
    )
    for (const i of issues) {
      io.stderr.write(`  [${i.code}] ${i.at}: ${i.message}\n`)
    }
  }
  if (issues.length === 0) return { exitCode: EXIT.OK }
  // Validation failures are CLI-level until we have a more granular code.
  return { exitCode: EXIT.CLI_ERROR }
}
