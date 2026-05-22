// Testing helpers exported from `@skelm/core/testing`. These are public:
// customers writing workflow tests use them, plugin authors use them when
// running the contract suite.

import { describe, expect, it } from 'vitest'
import {
  type AgentRequest,
  type AgentResponse,
  type BackendCapabilities,
  BackendCapabilityError,
  type BackendContext,
  BackendRegistry,
  type InferRequest,
  type InferResponse,
  type SkelmBackend,
  type Usage,
} from './backend.js'
import { agent, code, pipeline } from './builders.js'
import type { TestResult } from './builders.js'
import type { AgentPermissions } from './permissions.js'
import { runPipeline } from './runner.js'
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
 * ```ts
 * const gw = gatewayFixture({ port: 4099 })
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
  configFile?: string | ((ctx: Context) => string)
  startupTimeoutMs?: number
}): {
  readonly port: number
  start(): CodeStep<{ pid: number; port: number }>
  stop(): CodeStep<{ durationMs: number }>
} {
  const port = opts.port ?? 4099

  return {
    port,
    start: () =>
      code<{ pid: number; port: number }>({
        id: `gateway-start-${port}`,
        permissions: testExecPermissions,
        run: async (ctx) => {
          const dataDir =
            typeof opts.dataDir === 'function'
              ? opts.dataDir(ctx)
              : (opts.dataDir ?? ctx.workspace?.path ?? `/tmp/skelm-gw-${port}`)
          const configFile =
            typeof opts.configFile === 'function' ? opts.configFile(ctx) : opts.configFile

          await ctx.exec?.({
            command: 'skelm',
            args: [
              'gateway',
              'start',
              '--detach',
              '--http-port',
              String(port),
              '--data-dir',
              dataDir,
              ...(configFile !== undefined ? ['--config', configFile] : []),
            ],
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
                  })
                  if (pidR !== undefined) {
                    const info = JSON.parse(pidR.stdout || '{}') as { pid?: number }
                    if (typeof info.pid === 'number') pid = info.pid
                  }
                } catch {
                  // status probe is best-effort
                }
                return { pid, port }
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
          try {
            await ctx.exec?.({
              command: 'skelm',
              args: ['gateway', 'stop'],
            })
          } catch {
            // already stopped — fine
          }
          return { durationMs: Date.now() - start }
        },
      }),
  }
}

// =============================================================================
// Backend contract suite (vitest-driven). Keep below the self-test primitives.
// =============================================================================

/**
 * Build a deterministic fixture backend for tests. Provide a map keyed
 * either by step id or by an arbitrary route; the backend's `infer()` calls
 * `respond(req)` and returns the result. Recorded calls are exposed as
 * `calls` for assertions.
 */
export function fixtureBackend(opts: {
  id: string
  label?: string
  capabilities?: Partial<BackendCapabilities>
  respond: (req: InferRequest) => InferResponse | Promise<InferResponse>
}): SkelmBackend & { readonly calls: ReadonlyArray<InferRequest> } {
  const calls: InferRequest[] = []

  const capabilities: BackendCapabilities = {
    prompt: true,
    streaming: false,
    sessionLifecycle: false,
    mcp: false,
    skills: false,
    modelSelection: true,
    toolPermissions: 'unsupported',
    ...opts.capabilities,
  }

  const backend: SkelmBackend & { calls: InferRequest[] } = {
    id: opts.id,
    capabilities,
    calls,
    async infer(req: InferRequest, _ctx: BackendContext): Promise<InferResponse> {
      calls.push(req)
      return opts.respond(req)
    },
  }
  if (opts.label !== undefined) {
    Object.assign(backend, { label: opts.label })
  }
  return backend
}

export type BackendContractSuite = 'infer' | 'agent' | 'permission-gate'

export interface BackendContractCase<TRequest, TResponse> {
  readonly name: string
  readonly request: TRequest
  readonly context?: Partial<BackendContext>
  readonly assert?: (response: TResponse) => void | Promise<void>
}

export interface BackendContractOptions {
  readonly name?: string
  readonly skip?: readonly BackendContractSuite[]
  readonly inferCases?: readonly BackendContractCase<InferRequest, InferResponse>[]
  readonly agentCases?: readonly BackendContractCase<AgentRequest, AgentResponse>[]
}

export function runBackendContract(
  backendOrFactory: SkelmBackend | (() => SkelmBackend | Promise<SkelmBackend>),
  options: BackendContractOptions = {},
): void {
  const name =
    options.name ?? (typeof backendOrFactory === 'function' ? 'backend' : backendOrFactory.id)
  const skipped = new Set(options.skip ?? [])

  describe(`${name} backend contract`, () => {
    it('reports capabilities consistent with its implemented methods', async () => {
      await withBackend(backendOrFactory, async (backend) => {
        expect(backend.id.length).toBeGreaterThan(0)
        if (backend.capabilities.prompt) {
          expect(typeof backend.infer).toBe('function')
        } else {
          expect(backend.infer).toBeUndefined()
        }
        expect(['native', 'wrapped', 'unsupported']).toContain(backend.capabilities.toolPermissions)
      })
    })

    if (!skipped.has('infer')) {
      const inferCases = options.inferCases ?? [
        { name: 'basic infer', request: basicInferRequest() },
      ]
      for (const inferCase of inferCases) {
        it(`satisfies infer case: ${inferCase.name}`, async () => {
          await withBackend(backendOrFactory, async (backend) => {
            if (!backend.capabilities.prompt || typeof backend.infer !== 'function') {
              throw new Error(`backend ${backend.id} does not satisfy the infer contract`)
            }
            const response = await backend.infer(inferCase.request, buildContext(inferCase.context))
            assertInferResponseShape(response, inferCase.request)
            await inferCase.assert?.(response)
          })
        })
      }
    }

    if (!skipped.has('agent')) {
      const agentCases = options.agentCases ?? [
        { name: 'basic agent run', request: basicAgentRequest() },
      ]
      for (const agentCase of agentCases) {
        it(`satisfies agent case: ${agentCase.name}`, async () => {
          await withBackend(backendOrFactory, async (backend) => {
            if (typeof backend.run !== 'function') {
              throw new Error(`backend ${backend.id} does not satisfy the agent contract`)
            }
            const response = await backend.run(agentCase.request, buildContext(agentCase.context))
            assertAgentResponseShape(response, agentCase.request)
            await agentCase.assert?.(response)
          })
        })
      }
    }

    if (!skipped.has('permission-gate')) {
      it('fails closed when permissions exceed backend support', async () => {
        await withBackend(backendOrFactory, async (backend) => {
          if (typeof backend.run !== 'function') return
          if (backend.capabilities.toolPermissions === 'native') return

          const registry = new BackendRegistry()
          registry.register(backend)

          const permissions =
            backend.capabilities.toolPermissions === 'wrapped'
              ? { networkEgress: 'allow' as const }
              : { allowedTools: ['gh.list_issues'] }

          const workflow = pipeline({
            id: `contract-${backend.id}-permissions`,
            steps: [
              agent({
                id: 'work',
                backend: backend.id,
                prompt: 'contract permission gate',
                permissions,
              }),
            ],
          })

          const run = await runPipeline(workflow, undefined, { backends: registry })
          expect(run.status).toBe('failed')
          expect(run.error?.name).toBe(BackendCapabilityError.name)
        })
      })
    }
  })
}

async function withBackend(
  backendOrFactory: SkelmBackend | (() => SkelmBackend | Promise<SkelmBackend>),
  run: (backend: SkelmBackend) => Promise<void>,
): Promise<void> {
  if (typeof backendOrFactory !== 'function') {
    await run(backendOrFactory)
    return
  }

  const backend = await backendOrFactory()
  try {
    await run(backend)
  } finally {
    await backend.dispose?.()
  }
}

function buildContext(context: Partial<BackendContext> = {}): BackendContext {
  return {
    signal: AbortSignal.timeout(5_000),
    ...context,
  }
}

function basicInferRequest(): InferRequest {
  return {
    messages: [{ role: 'user', content: 'ping' }],
  }
}

function basicAgentRequest(): AgentRequest {
  return {
    prompt: 'ping',
  }
}

function assertInferResponseShape(response: InferResponse, request: InferRequest): void {
  expect(response).toBeTypeOf('object')
  if (request.outputSchema !== undefined) {
    expect(response.structured).not.toBeUndefined()
  } else {
    expect(response.text !== undefined || response.structured !== undefined).toBe(true)
  }
  if (response.text !== undefined) {
    expect(typeof response.text).toBe('string')
  }
  assertUsageShape(response.usage)
}

function assertAgentResponseShape(response: AgentResponse, request: AgentRequest): void {
  expect(response).toBeTypeOf('object')
  if (request.outputSchema !== undefined) {
    expect(response.structured).not.toBeUndefined()
  } else {
    expect(response.text !== undefined || response.structured !== undefined).toBe(true)
  }
  if (response.text !== undefined) {
    expect(typeof response.text).toBe('string')
  }
  if (response.stopReason !== undefined) {
    expect(typeof response.stopReason).toBe('string')
  }
  assertUsageShape(response.usage)
}

function assertUsageShape(usage: Usage | undefined): void {
  if (usage === undefined) return
  for (const value of [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.reasoningTokens,
    usage.costUsd,
  ]) {
    if (value !== undefined) {
      expect(typeof value).toBe('number')
    }
  }
  if (usage.extras !== undefined) {
    for (const value of Object.values(usage.extras)) {
      expect(typeof value).toBe('number')
    }
  }
}
