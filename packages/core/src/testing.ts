// Self-test authoring primitives exported from `@skelm/core/testing`.
//
// This module is intentionally vitest-free so workflows running under
// `skelm run` (not vitest) can import from `@skelm/core/testing` without
// triggering vitest's worker-state init. The backend-contract suite (which
// does use vitest) lives at `@skelm/core/testing/contract`.

import { code } from './builders.js'
import type { TestResult } from './builders.js'
import type { AgentPermissions } from './permissions.js'
import type { CodeStep, Context, StepId } from './types.js'

// =============================================================================
// Self-test authoring primitives — used by `skelm run` workflows that test
// skelm itself. Keep this section vitest-free (no describe/it/expect calls).
// =============================================================================

// `check()` and `TestResult` live in builders.ts so they can be re-exported
// from the top-level `skelm` package without dragging vitest into its module
// graph. Re-exported here so consumers of `@skelm/core/testing` find them in
// the same place as the rest of the test-authoring helpers.
export { check, type TestResult } from './builders.js'

/**
 * Aggregated outcome of one test section (typically one pipeline). Produced
 * by `summarizeChecks()` from the `TestResult` outputs of the section's
 * `check()` steps.
 */
export interface SectionResult {
  readonly sectionId: string
  readonly checks: readonly TestResult[]
  readonly passCount: number
  readonly failCount: number
  readonly skipCount: number
  readonly durationMs: number
  readonly status: 'pass' | 'fail' | 'skip'
}

/**
 * Top-level run report aggregated by `summarizeSections()` from the
 * `SectionResult` outputs of an orchestrator pipeline.
 */
export interface SummaryReport {
  readonly sections: readonly SectionResult[]
  readonly totalPass: number
  readonly totalFail: number
  readonly totalSkip: number
  readonly durationMs: number
  readonly status: 'pass' | 'fail'
}

/**
 * Aggregate the `TestResult` values produced by a section's `check()` steps
 * into a `SectionResult`. Call from a pipeline's `finalize`.
 *
 * Missing step ids (because the run was cancelled or the step was skipped by
 * a `when` predicate) are counted as `'skip'`.
 */
export function summarizeChecks(
  sectionId: string,
  checkIds: readonly string[],
  ctx: Context,
  startedAt: number,
): SectionResult {
  const checks: TestResult[] = checkIds.map((id) => {
    const r = ctx.get<TestResult>(id)
    if (r === undefined) {
      return { id, status: 'skip', durationMs: 0 }
    }
    return r
  })
  const passCount = checks.filter((c) => c.status === 'pass').length
  const failCount = checks.filter((c) => c.status === 'fail').length
  const skipCount = checks.filter((c) => c.status === 'skip').length
  return {
    sectionId,
    checks,
    passCount,
    failCount,
    skipCount,
    durationMs: Date.now() - startedAt,
    status:
      failCount > 0 ? 'fail' : checks.length > 0 && skipCount === checks.length ? 'skip' : 'pass',
  }
}

/**
 * Aggregate the `SectionResult` values produced by an orchestrator's
 * per-section `invoke()` steps into a `SummaryReport`. Call from the
 * orchestrator pipeline's `finalize`.
 */
export function summarizeSections(
  sectionIds: readonly string[],
  ctx: Context,
  startedAt: number,
): SummaryReport {
  const sections: SectionResult[] = sectionIds.map((id) => {
    const r = ctx.get<SectionResult>(id)
    if (r === undefined) {
      return {
        sectionId: id,
        checks: [],
        passCount: 0,
        failCount: 0,
        skipCount: 0,
        durationMs: 0,
        status: 'skip' as const,
      }
    }
    return r
  })
  const totalPass = sections.reduce((n, s) => n + s.passCount, 0)
  const totalFail = sections.reduce((n, s) => n + s.failCount, 0)
  const totalSkip = sections.reduce((n, s) => n + s.skipCount, 0)
  return {
    sections,
    totalPass,
    totalFail,
    totalSkip,
    durationMs: Date.now() - startedAt,
    status: totalFail > 0 ? 'fail' : 'pass',
  }
}

/**
 * Pre-built permissions for `check()` steps that drive the skelm test toolset.
 * Covers the standard executables a live test pass needs (skelm, node, npx,
 * curl, gh, pnpm, git, bash/sh, jq) and allows network egress.
 *
 * Do **not** use in production pipelines — this is a test-only preset that
 * gives broad shell access.
 */
export const testExecPermissions: AgentPermissions = Object.freeze({
  allowedExecutables: Object.freeze([
    'skelm',
    'node',
    'npx',
    'curl',
    'gh',
    'pnpm',
    'git',
    'bash',
    'sh',
    'jq',
  ]) as readonly string[],
  networkEgress: 'allow',
}) as AgentPermissions

/**
 * Returns a `code()` step that polls a URL until it responds with the
 * expected status code, or rejects with a timeout error. Use after starting
 * a long-running fixture (e.g. a gateway) in a prior step.
 *
 * ```ts
 * probeHttp({ id: 'ready', url: 'http://localhost:4099/healthz', timeoutMs: 10_000 })
 * ```
 */
export function probeHttp(def: {
  id: StepId
  url: string | ((ctx: Context) => string)
  expectedStatus?: number
  timeoutMs?: number
  pollMs?: number
  permissions?: AgentPermissions
}): CodeStep<{ status: number; durationMs: number }> {
  return code<{ status: number; durationMs: number }>({
    id: def.id,
    permissions: def.permissions ?? testExecPermissions,
    run: async (ctx) => {
      const url = typeof def.url === 'function' ? def.url(ctx) : def.url
      const expectedStatus = def.expectedStatus ?? 200
      const timeoutMs = def.timeoutMs ?? 15_000
      const pollMs = def.pollMs ?? 250
      const deadline = Date.now() + timeoutMs
      const start = Date.now()

      while (Date.now() < deadline) {
        try {
          const r = await ctx.exec?.({
            command: 'curl',
            args: ['-s', '-o', '/dev/null', '-w', '%{http_code}', url],
            timeoutMs: pollMs * 4,
          })
          if (r !== undefined) {
            const status = Number.parseInt(r.stdout.trim(), 10)
            if (status === expectedStatus) {
              return { status, durationMs: Date.now() - start }
            }
          }
        } catch {
          // process not up yet — keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }
      throw new Error(
        `probeHttp(${def.id}): ${url} did not return ${expectedStatus} within ${timeoutMs}ms`,
      )
    },
  })
}

/**
 * Manages a skelm gateway process for test pipelines. `start()` and `stop()`
 * are independent `code()` steps so their events and timings are recorded
 * separately. `stop()` carries `continueOnError: true` so the gateway is
 * always cleaned up even if earlier steps fail.
 *
 * The `dataDir` option controls per-instance gateway state (lockfile, run
 * store, audit log). It is threaded to the child as `SKELM_STATE_DIR` env so
 * two `gatewayFixture` instances on different ports can run side-by-side
 * without sharing a lockfile. `configFile`, when supplied, is used as the
 * spawn's working directory — the CLI walks up from `cwd` to find
 * `skelm.config.mts`, so pointing `configFile` at a directory containing
 * the desired config picks it up.
 *
 * ```ts
 * const gw = gatewayFixture({ port: 4099, dataDir: '/tmp/gw-4099' })
 * pipeline({
 *   id: 'gateway-section',
 *   steps: [
 *     gw.start(),
 *     check({ id: 'healthz', run: async (ctx) => ... }),
 *     gw.stop(),
 *   ],
 * })
 * ```
 */
export function gatewayFixture(opts: {
  port?: number
  dataDir?: string | ((ctx: Context) => string)
  /**
   * Optional working directory for the spawned gateway process. The CLI
   * walks up from `cwd` to find `skelm.config.mts`; point this at the
   * directory holding the config you want loaded. (The CLI does not yet
   * accept a `--config` flag.)
   */
  configFile?: string | ((ctx: Context) => string)
  startupTimeoutMs?: number
  /**
   * When true, delete the dataDir before starting the gateway so each
   * test invocation begins with a clean run database and no stale
   * dynamic-schedules. Use for sections that need isolation rather than
   * durability across invocations.
   */
  cleanDataDir?: boolean
}): {
  readonly port: number
  start(): CodeStep<{ pid: number; port: number; dataDir: string }>
  stop(): CodeStep<{ durationMs: number }>
} {
  const port = opts.port ?? 4099

  return {
    port,
    start: () =>
      code<{ pid: number; port: number; dataDir: string }>({
        id: `gateway-start-${port}`,
        permissions: testExecPermissions,
        run: async (ctx) => {
          const dataDir =
            typeof opts.dataDir === 'function'
              ? opts.dataDir(ctx)
              : (opts.dataDir ?? ctx.workspace?.path ?? `/tmp/skelm-gw-${port}`)
          const cwd = typeof opts.configFile === 'function' ? opts.configFile(ctx) : opts.configFile
          if (opts.cleanDataDir === true) {
            await ctx.exec?.({
              command: 'bash',
              args: ['-c', `rm -rf -- ${JSON.stringify(dataDir)}`],
            })
          }
          // The CLI's `gateway start` does not (yet) accept --data-dir or
          // --config flags; it picks them up from SKELM_STATE_DIR and the
          // working directory. Pass both per-instance so two fixtures on
          // different ports keep distinct state and don't share a lockfile.
          const childEnv: Record<string, string> = {
            ...(Object.fromEntries(
              Object.entries(process.env).filter(([, v]) => v !== undefined),
            ) as Record<string, string>),
            SKELM_STATE_DIR: dataDir,
          }

          await ctx.exec?.({
            command: 'skelm',
            args: ['gateway', 'start', '--detach', '--http-port', String(port)],
            env: childEnv,
            ...(cwd !== undefined && { cwd }),
            throwOnNonZero: true,
          })

          const timeoutMs = opts.startupTimeoutMs ?? 15_000
          const deadline = Date.now() + timeoutMs
          while (Date.now() < deadline) {
            try {
              const r = await ctx.exec?.({
                command: 'curl',
                args: ['-sf', `http://localhost:${port}/healthz`],
                timeoutMs: 1_000,
              })
              if (r !== undefined && r.exitCode === 0) {
                let pid = -1
                try {
                  const pidR = await ctx.exec?.({
                    command: 'skelm',
                    args: ['gateway', 'status', '--json'],
                    env: childEnv,
                  })
                  if (pidR !== undefined) {
                    const info = JSON.parse(pidR.stdout || '{}') as { pid?: number }
                    if (typeof info.pid === 'number') pid = info.pid
                  }
                } catch {
                  // status probe is best-effort
                }
                return { pid, port, dataDir }
              }
            } catch {
              // keep polling
            }
            await new Promise((resolve) => setTimeout(resolve, 250))
          }
          throw new Error(
            `gatewayFixture: gateway on port ${port} did not become ready within ${timeoutMs}ms`,
          )
        },
      }),

    stop: () =>
      code<{ durationMs: number }>({
        id: `gateway-stop-${port}`,
        continueOnError: true,
        permissions: testExecPermissions,
        run: async (ctx) => {
          const start = Date.now()
          const dataDir =
            typeof opts.dataDir === 'function'
              ? opts.dataDir(ctx)
              : (opts.dataDir ?? ctx.workspace?.path ?? `/tmp/skelm-gw-${port}`)
          const childEnv: Record<string, string> = {
            ...(Object.fromEntries(
              Object.entries(process.env).filter(([, v]) => v !== undefined),
            ) as Record<string, string>),
            SKELM_STATE_DIR: dataDir,
          }
          try {
            await ctx.exec?.({
              command: 'skelm',
              args: ['gateway', 'stop'],
              env: childEnv,
            })
          } catch {
            // already stopped — fine
          }
          return { durationMs: Date.now() - start }
        },
      }),
  }
}
