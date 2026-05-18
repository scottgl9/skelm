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
import { basename } from 'node:path'
import { PermissionDeniedError } from './errors.js'
import type { TrustEnforcer } from './permissions.js'
import type { ExecFn, ExecRequest, ExecResult } from './types.js'

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 // 10 MiB
const KILL_GRACE_MS = 5_000

/**
 * Build a `ctx.exec` function bound to a step's resolved policy and the
 * run-level AbortSignal. The returned function is what gets attached to
 * `ctx.exec` in `runCodeStep`.
 */
export function createExec(enforcer: TrustEnforcer, runSignal: AbortSignal): ExecFn {
  return async function exec(req: ExecRequest): Promise<ExecResult> {
    const { binary, argv } = resolveCommand(req)
    const binName = basename(binary)
    const decision = enforcer.canExec(binName)
    if (!decision.allow) {
      throw new PermissionDeniedError(
        `exec denied: "${binName}" not in allowedExecutables (reason: ${decision.reason})`,
      )
    }
    return await runChild(binary, argv, req, runSignal)
  }
}

function resolveCommand(req: ExecRequest): { binary: string; argv: string[] } {
  const args = req.args ?? []
  let chosen: 'command' | 'python' | 'bash' | undefined
  if (req.command !== undefined) chosen = 'command'
  if (req.python !== undefined) {
    if (chosen !== undefined) throw new Error('exec: choose exactly one of command/python/bash')
    chosen = 'python'
  }
  if (req.bash !== undefined) {
    if (chosen !== undefined) throw new Error('exec: choose exactly one of command/python/bash')
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
      throw new Error('exec: must supply one of command/python/bash')
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

  const { exitCode, signal } = await new Promise<{
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

  runSignal.removeEventListener('abort', onAbort)

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
