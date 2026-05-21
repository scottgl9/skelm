// `ctx.exec` implementation for `code()` steps.
//
// Spawns external executables under TrustEnforcer.canExec enforcement.
// Default-deny: a step with no `permissions.allowedExecutables` denies every
// call. The resolved binary's basename (e.g. `python3`, `git`, `bash`) is
// the value checked against the policy — interpreters for `python:` / `bash:`
// shortcuts are resolved against `SKELM_PYTHON` / `SKELM_BASH` env vars
// before the check, so authors must allowlist the actual interpreter name.

// @subprocess-ok: code() exec helper, gated by TrustEnforcer.canExec.
// Subprocess spawning happens only after a successful permission check; the
// step-level policy is intersected with project defaults by the runner.
import { type ChildProcess, spawn } from 'node:child_process'
import { basename, sep } from 'node:path'
import { ExecConfigError, PermissionDeniedError } from './errors.js'
import type { EventBus, RunEvent } from './events.js'
import type { TrustEnforcer } from './permissions.js'
import type { ExecFn, ExecRequest, ExecResult, RunId, StepId } from './types.js'

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 // 10 MiB
const KILL_GRACE_MS = 5_000

export interface CreateExecOptions {
  /** Event bus for audit emission. When supplied, every exec call emits
   *  tool.call + tool.result (or permission.denied on deny). */
  events?: EventBus
  runId?: RunId
  stepId?: StepId
}

/**
 * Build a `ctx.exec` function bound to a step's resolved policy and the
 * run-level AbortSignal. The returned function is what gets attached to
 * `ctx.exec` in `runCodeStep`.
 *
 * When an event bus + run/step id are supplied, every exec call is audited
 * through the existing tool.call / tool.result / permission.denied audit
 * subscriber. Without them the helper still enforces canExec but skips
 * audit emission — useful for embedded callers that don't have a bus.
 */
export function createExec(
  enforcer: TrustEnforcer,
  runSignal: AbortSignal,
  options: CreateExecOptions = {},
): ExecFn {
  const { events, runId, stepId } = options
  const canAudit = events !== undefined && runId !== undefined && stepId !== undefined
  return async function exec(req: ExecRequest): Promise<ExecResult> {
    const { binary, argv } = resolveCommand(req)
    // Default-deny on path-injection: if the binary value contains a path
    // separator the policy must allowlist that exact value. Without this,
    // an allowlist of ['git'] would accept '/tmp/evil/git' because the
    // basename matched.
    const hasPathSeparator = binary.includes('/') || binary.includes(sep)
    const checkName = hasPathSeparator ? binary : basename(binary)
    const decision = enforcer.canExec(checkName)
    if (!decision.allow) {
      if (canAudit) {
        const denyEvent: Extract<RunEvent, { type: 'permission.denied' }> = {
          type: 'permission.denied',
          runId: runId as RunId,
          stepId: stepId as StepId,
          dimension: 'executable',
          detail: `exec denied: "${checkName}" not in allowedExecutables`,
          at: Date.now(),
        }
        events?.publish(denyEvent)
      }
      throw new PermissionDeniedError(
        `exec denied: "${checkName}" not in allowedExecutables (reason: ${decision.reason})`,
      )
    }
    const toolName = `exec:${basename(binary)}`
    const startedAt = Date.now()
    if (canAudit) {
      events?.publish({
        type: 'tool.call',
        runId: runId as RunId,
        stepId: stepId as StepId,
        tool: toolName,
        arguments: { binary, argv },
        at: startedAt,
      })
    }
    const result = await runChild(binary, argv, req, runSignal)
    if (canAudit) {
      events?.publish({
        type: 'tool.result',
        runId: runId as RunId,
        stepId: stepId as StepId,
        tool: toolName,
        result: {
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
        },
        durationMs: result.durationMs,
        at: Date.now(),
      })
    }
    return result
  }
}

function resolveCommand(req: ExecRequest): { binary: string; argv: string[] } {
  const args = req.args ?? []
  let chosen: 'command' | 'python' | 'bash' | undefined
  if (req.command !== undefined) chosen = 'command'
  if (req.python !== undefined) {
    if (chosen !== undefined)
      throw new ExecConfigError('exec: choose exactly one of command/python/bash')
    chosen = 'python'
  }
  if (req.bash !== undefined) {
    if (chosen !== undefined)
      throw new ExecConfigError('exec: choose exactly one of command/python/bash')
    chosen = 'bash'
  }
  switch (chosen) {
    case 'command':
      return { binary: req.command as string, argv: [...args] }
    case 'python': {
      const interpreter = process.env.SKELM_PYTHON ?? 'python3'
      return { binary: interpreter, argv: [req.python as string, ...args] }
    }
    case 'bash': {
      const interpreter = process.env.SKELM_BASH ?? 'bash'
      return { binary: interpreter, argv: [req.bash as string, ...args] }
    }
    default:
      throw new ExecConfigError('exec: must supply one of command/python/bash')
  }
}

async function runChild(
  binary: string,
  argv: readonly string[],
  req: ExecRequest,
  runSignal: AbortSignal,
): Promise<ExecResult> {
  const startedAt = Date.now()
  const maxStdout = req.maxStdoutBytes ?? DEFAULT_MAX_BYTES
  const maxStderr = req.maxStderrBytes ?? DEFAULT_MAX_BYTES

  const child: ChildProcess = spawn(binary, [...argv], {
    cwd: req.cwd,
    env: req.env !== undefined ? { ...process.env, ...req.env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  let stdoutTruncated = false
  let stderrTruncated = false

  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdoutTruncated) return
    if (stdout.length + chunk.length > maxStdout) {
      stdout += chunk.toString('utf8', 0, maxStdout - stdout.length)
      stdoutTruncated = true
      return
    }
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderrTruncated) return
    if (stderr.length + chunk.length > maxStderr) {
      stderr += chunk.toString('utf8', 0, maxStderr - stderr.length)
      stderrTruncated = true
      return
    }
    stderr += chunk.toString('utf8')
  })

  if (req.stdin !== undefined && child.stdin) {
    child.stdin.write(req.stdin)
  }
  child.stdin?.end()

  let timedOut = false
  let timeoutHandle: NodeJS.Timeout | undefined
  let killHandle: NodeJS.Timeout | undefined
  const cleanup = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (killHandle) clearTimeout(killHandle)
  }

  const armKill = () => {
    if (killHandle) return
    killHandle = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL')
    }, KILL_GRACE_MS)
  }

  if (req.timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      armKill()
    }, req.timeoutMs)
  }

  const onAbort = () => {
    child.kill('SIGTERM')
    armKill()
  }
  if (runSignal.aborted) onAbort()
  else runSignal.addEventListener('abort', onAbort, { once: true })

  let exitCode: number
  let signal: NodeJS.Signals | null
  try {
    const result = await new Promise<{
      exitCode: number
      signal: NodeJS.Signals | null
    }>((resolve, reject) => {
      child.once('error', (err) => {
        cleanup()
        reject(err)
      })
      child.once('close', (code, sig) => {
        cleanup()
        resolve({ exitCode: code ?? -1, signal: sig })
      })
    })
    exitCode = result.exitCode
    signal = result.signal
  } finally {
    // Always detach the abort listener, even when the child errored before
    // close — otherwise each failed exec call leaks a listener on runSignal.
    runSignal.removeEventListener('abort', onAbort)
  }

  const result: ExecResult = {
    exitCode,
    stdout,
    stderr,
    signal,
    durationMs: Date.now() - startedAt,
    timedOut,
  }

  if (req.throwOnNonZero === true && exitCode !== 0) {
    throw new Error(
      `exec: "${basename(binary)}" exited with code ${exitCode}${timedOut ? ' (timed out)' : ''}`,
    )
  }
  return result
}
