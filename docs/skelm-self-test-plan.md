# skelm Self-Test Plan
# Using skelm Workflows to Live-Test skelm Itself

**Status:** Planning  
**Target:** skelm v0.5.x  
**Author:** Clawmander  
**Date:** 2026-05-22

---

## Overview

The goal is to convert `test_plan/` — the existing markdown-driven live test harness — into
skelm workflows that run inside skelm itself. Every feature gets a live assertion rather than
a human checkbox. The end state: `skelm run workflows/test-runner.workflow.mts` runs a full
E2E pass, and a `github-pr` trigger fires it automatically on every push to `scottgl9/skelm`.

This document covers:
1. The target workflow architecture
2. Exact skelm feature additions required (with implementation detail)
3. The phased delivery plan
4. The final workflow structure

---

## Part 1 — Target Architecture

### Three layers

```
workflows/
  test-runner.workflow.mts          # orchestrator: runs all sections, emits report
  sections/
    00-preconditions.workflow.mts
    01-build-and-static.workflow.mts
    02-cli-surface.workflow.mts
    03-workflow-execution.workflow.mts
    05-gateway-http.workflow.mts
    ...
    33-fresh-install-simulation.workflow.mts
```

**Orchestrator** (`test-runner.workflow.mts`)
- Uses `parallel()` with `onError: 'continue'` to run independent sections concurrently
- Uses `invoke()` to call per-section sub-pipelines
- Collects `SectionResult` values in `finalize`
- Emits a structured `SummaryReport` (total pass/fail/skip counts, per-section breakdown, duration)
- Can be triggered via cron, `github-pr`, or `skelm run` directly

**Per-section workflows** (e.g. `03-workflow-execution.workflow.mts`)
- Each section is a `pipeline()` returning `SectionResult`
- Every individual check is a `check()` step (new primitive, see Part 2)
- Checks run sequentially within a section; sections run in parallel via the orchestrator
- Section failures are soft — the orchestrator always collects all results

**Probe helpers** (shared utilities in `workflows/lib/`)
- `gatewayFixture.mts` — start/stop a gateway process, poll `/healthz`
- `skelmRun.mts` — run `skelm run <workflow> --input <json>`, return stdout/stderr/exitCode
- `curlJson.mts` — `curl -s <url>`, return parsed JSON + status
- `assertOutput.mts` — compare actual vs expected output, throw with diff on mismatch

---

## Part 2 — Required skelm Feature Additions

### Feature 1: `continueOnError` on pipeline steps

**Problem:** The runner's sequential step loop breaks on the first step failure. A test
section that has 20 checks stops after the first failing check. All remaining checks are
never run, making it impossible to see the full failure surface.

`parallel()` already has `onError: 'continue'` that does exactly what we need — but only
for parallel children. The sequential pipeline loop has no equivalent.

**Change: `types.ts`**

Add `continueOnError?: boolean` to every step interface that appears in the top-level
pipeline `steps` array:

```typescript
// Add to CodeStep, LlmStep, AgentStep, ParallelStep, ForEachStep,
// BranchStep, LoopStep, WaitStep, PipelineStep, InvokeStep, IdempotentStep

interface CodeStep<TOutput> {
  // ... existing fields ...
  /**
   * When true, a step failure is recorded in StepResult but does not abort
   * the pipeline. The step's output in ctx.steps[id] is undefined (same as
   * today). The pipeline's own status is determined by the finalize function
   * or defaults to 'failed' if any step failed and no finalize is present.
   *
   * Used by check() steps in test pipelines: every assertion runs regardless
   * of whether earlier assertions passed.
   */
  readonly continueOnError?: boolean
}
```

**Change: `builders.ts`**

Add `continueOnError?: boolean` to the `code()`, `llm()`, `agent()`, `invoke()`,
`forEach()`, `parallel()` builder parameter objects and pass it through to the frozen
step object.

**Change: `runner.ts`**

In the main `for (const step of pipeline.steps)` loop, the catch block currently does:

```typescript
} catch (err) {
  // ... record StepResult with status: 'failed' ...
  runStatus = 'failed'
  runError = serialized
  break   // ← THIS IS WHAT WE CHANGE
}
```

Change to:

```typescript
} catch (err) {
  const completedAt = Date.now()
  const serialized = serializeError(err)
  stepResults.push({
    id: step.id,
    kind: step.kind,
    status: 'failed',
    output: undefined,
    startedAt: stepStart,
    completedAt,
    error: serialized,
  })
  events.publish({ type: 'step.error', runId, stepId: step.id, kind: step.kind,
    error: serialized, at: completedAt })

  if (err instanceof RunCancelledError) {
    runStatus = 'cancelled'
    runError = serialized
    break
  }

  if (step.continueOnError) {
    // Record failure but keep going. runStatus tracks the worst seen.
    if (runStatus === 'running') {
      runStatus = 'failed'
      runError = serialized  // last error wins; finalize can inspect stepResults for all
    }
    continue   // ← key change
  }

  runStatus = 'failed'
  runError = serialized
  break
}
```

`RunCancelledError` must still break — cancellation is not a soft failure.

**Runtime impact:** Zero for existing pipelines. `continueOnError` is opt-in, defaults
to `undefined` (falsy), existing behavior unchanged.

**Size:** ~15 lines changed in `runner.ts`, ~12 fields added across step interfaces.

---

### Feature 2: `check()` step builder + `TestResult` type

**Problem:** Test pipelines need a step that:
1. Runs an assertion function
2. Catches assertion failures and converts them to `TestResult { status: 'fail' }` rather
   than raw errors
3. Always sets `continueOnError: true` implicitly
4. Returns a structured `TestResult` so `finalize` can aggregate pass/fail counts cleanly

**Change: `testing.ts`** (new exports, no runtime changes)

```typescript
export interface TestResult {
  readonly id: string
  readonly status: 'pass' | 'fail' | 'skip'
  readonly message?: string
  /** The value that was expected (for display in reports). */
  readonly expected?: unknown
  /** The value that was actually observed. */
  readonly actual?: unknown
  readonly durationMs: number
}

export interface SectionResult {
  readonly sectionId: string
  readonly checks: readonly TestResult[]
  readonly passCount: number
  readonly failCount: number
  readonly skipCount: number
  readonly durationMs: number
  readonly status: 'pass' | 'fail' | 'skip'
}

export interface SummaryReport {
  readonly sections: readonly SectionResult[]
  readonly totalPass: number
  readonly totalFail: number
  readonly totalSkip: number
  readonly durationMs: number
  readonly status: 'pass' | 'fail'
}
```

**Change: `builders.ts`** (new `check()` builder)

```typescript
/**
 * Author a test assertion step. `run` should return the observed value or
 * throw (or call `assert.*`) to signal failure. The step always sets
 * continueOnError: true — a failing check records TestResult { status: 'fail' }
 * and the pipeline continues to the next check.
 *
 * Use inside test pipelines. The pipeline's finalize can collect all
 * ctx.steps results (which are TestResult values) and aggregate them into
 * a SectionResult via summarizeChecks().
 */
export function check(def: {
  id: StepId
  /** Human-readable description of what is being checked. */
  description?: string
  run: (ctx: Context) => unknown | Promise<unknown>
  when?: WhenPredicate
  timeoutMs?: number
  permissions?: AgentPermissions
}): CodeStep<TestResult> {
  const wrapped = async (ctx: Context): Promise<TestResult> => {
    const start = Date.now()
    try {
      const actual = await def.run(ctx)
      return {
        id: def.id,
        status: 'pass',
        actual,
        durationMs: Date.now() - start,
      }
    } catch (err) {
      return {
        id: def.id,
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      }
    }
  }
  return code({
    id: def.id,
    run: wrapped,
    continueOnError: true,       // always soft-fail
    ...(def.timeoutMs !== undefined && { timeoutMs: def.timeoutMs }),
    ...(def.permissions !== undefined && { permissions: def.permissions }),
    ...(def.when !== undefined && { when: def.when }),
  })
}
```

**Change: `testing.ts`** (aggregation helpers)

```typescript
/**
 * Collect TestResult values from ctx.steps for the given step ids and
 * aggregate into a SectionResult. Call from pipeline finalize.
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
      // Step was skipped or never ran (e.g. pipeline was cancelled before it).
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
    status: failCount > 0 ? 'fail' : skipCount === checks.length ? 'skip' : 'pass',
  }
}

/**
 * Aggregate SectionResult values from the orchestrator's ctx.steps into
 * a SummaryReport. Call from the orchestrator pipeline's finalize.
 */
export function summarizeSections(
  sectionIds: readonly string[],
  ctx: Context,
  startedAt: number,
): SummaryReport {
  const sections = sectionIds.map((id) => {
    const r = ctx.get<SectionResult>(id)
    if (r === undefined) {
      return {
        sectionId: id, checks: [], passCount: 0, failCount: 0, skipCount: 0,
        durationMs: 0, status: 'skip' as const,
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
```

**Runtime impact:** None. Pure library additions.

---

### Feature 3: `workspace` on `code()` steps

**Problem:** `workspace` is only on `agent()` steps. Test check steps need ephemeral
isolated temp dirs — for scratch files, per-section gateway data dirs, cloned repos,
and test artifacts. Without workspace support on `code()`, every check step that needs
a temp dir must `mkdtemp` + `rm -rf` manually, leaking directories on failures.

**Change: `types.ts`**

Add `workspace?: WorkspaceConfig` to `CodeStep`:

```typescript
interface CodeStep<TOutput> {
  // ... existing fields ...
  /**
   * Optional workspace for this step. When present, the runner provisions a
   * workspace before the step runs and exposes it as ctx.workspace. Lifecycle
   * (cleanup) follows WorkspaceConfig.cleanup semantics.
   *
   * Supports 'ephemeral', 'persistent', 'mounted', and 'git-repo' modes,
   * identical to agent() steps.
   */
  readonly workspace?: WorkspaceConfig
}
```

**Change: `builders.ts`**

Add `workspace?: WorkspaceConfig` to `code()` parameters and pass through.

**Change: `execution/handlers.ts`** (`runCodeStep`)

The agent step handler (`runAgentStep`) already has workspace provisioning via
`WorkspaceManager`. Extract that provisioning block into a shared helper
`provisionWorkspace(step, ctx, runtime)` and call it from `runCodeStep` too:

```typescript
async function runCodeStep(step, ctx, runtime): Promise<unknown> {
  // NEW: provision workspace if declared
  let workspaceHandle: WorkspaceHandle | undefined
  if (step.workspace !== undefined && runtime?.workspaceManager !== undefined) {
    workspaceHandle = await runtime.workspaceManager.provision(
      step.workspace instanceof Function ? step.workspace(ctx) : step.workspace,
      { runId: ctx.run.runId, stepId: step.id }
    )
    runtime.setCurrentWorkspace(workspaceHandle)
    // register cleanup finalizer
    runtime.deferRunWorkspaceFinalizer(async (status) => {
      await runtime.workspaceManager!.release(workspaceHandle!, status)
    })
  }

  // ... rest of existing runCodeStep logic, ctx already picks up workspace ...
}
```

**Runtime impact:** Zero for existing pipelines. Workspace provisioning only fires when
`step.workspace` is set. `WorkspaceManager` is already wired into `ExecutionRuntime`.

**Size:** ~25 lines in `handlers.ts`, ~5 lines each in `types.ts` and `builders.ts`.

---

### Feature 4: `testExecPermissions` preset in `testing.ts`

**Problem:** Every `check()` step that shells out needs `permissions.allowedExecutables`
explicitly declared. Boilerplate on every step, and easy to forget.

**Change: `testing.ts`** (new export, no runtime changes)

```typescript
/**
 * Pre-built AgentPermissions for check() steps that drive the standard
 * skelm test toolset. Import and pass to check({ permissions: testExecPermissions }).
 *
 * Covers: skelm CLI, node, curl, gh, pnpm, git, bash, npx, jq.
 * Network: allow-all (test host has unrestricted network).
 *
 * Do NOT use in production pipelines. This is a test-only preset.
 */
export const testExecPermissions: AgentPermissions = {
  allowedExecutables: ['skelm', 'node', 'npx', 'curl', 'gh', 'pnpm', 'git', 'bash', 'sh', 'jq'],
  networkEgress: 'allow',
}
```

---

### Feature 5: `probeHttp()` helper in `testing.ts`

**Problem:** Test sections need to wait for gateway processes to become ready. `loop()`
can poll but requires verbose step + predicate wiring. `wait()` is for human-resume.

**Change: `testing.ts`** (new export, returns a `CodeStep`, no runtime changes)

```typescript
/**
 * Returns a code() step that polls a URL until it responds with the expected
 * status code, or times out. Use after starting a gateway in a prior step.
 *
 * The step fails (throws) on timeout. Set continueOnError on the enclosing
 * context if timeout should be a soft failure.
 */
export function probeHttp(def: {
  id: StepId
  url: string | ((ctx: Context) => string)
  expectedStatus?: number
  timeoutMs?: number
  pollMs?: number
  permissions?: AgentPermissions
}): CodeStep<{ status: number; durationMs: number }> {
  return code({
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
          const r = await ctx.exec!({
            command: 'curl',
            args: ['-s', '-o', '/dev/null', '-w', '%{http_code}', url],
            timeoutMs: pollMs * 2,
          })
          const code = parseInt(r.stdout.trim(), 10)
          if (code === expectedStatus) {
            return { status: code, durationMs: Date.now() - start }
          }
        } catch {
          // process not up yet, keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }
      throw new Error(
        `probeHttp(${def.id}): ${url} did not return ${expectedStatus} within ${timeoutMs}ms`,
      )
    },
  })
}
```

---

### Feature 6: `GatewayFixture` helper in `testing.ts`

**Problem:** Multiple test sections (05-gateway-http, 06-sse-polling, 28-gateway-lifecycle,
etc.) need to start a gateway, wait for readiness, run tests, and reliably stop the
gateway even on failure. Managing this ad-hoc in every section is fragile.

**Change: `testing.ts`** (new export, no runtime changes)

```typescript
/**
 * Manages a skelm gateway process for test pipelines. Start and stop are
 * separate code() steps so events and timing are recorded individually.
 *
 * Usage:
 *   const gw = gatewayFixture({ port: 4099 })
 *   pipeline({
 *     steps: [
 *       gw.start(),           // starts gateway, waits for /healthz
 *       check({ id: 'my-check', run: async ctx => {
 *         const r = await ctx.exec({ command: 'curl',
 *           args: ['-s', `http://localhost:${gw.port}/v1/runs`] })
 *         ...
 *       }}),
 *       gw.stop(),            // always runs (set continueOnError: true implicitly)
 *     ],
 *   })
 */
export function gatewayFixture(opts: {
  port?: number
  dataDir?: string | ((ctx: Context) => string)
  configFile?: string | ((ctx: Context) => string)
  startupTimeoutMs?: number
}): {
  port: number
  start(): CodeStep<{ pid: number; port: number }>
  stop(): CodeStep<{ durationMs: number }>
} {
  const port = opts.port ?? 4099

  return {
    port,

    start: () => code({
      id: `gateway-start-${port}`,
      permissions: testExecPermissions,
      run: async (ctx) => {
        const dataDir = typeof opts.dataDir === 'function'
          ? opts.dataDir(ctx)
          : (opts.dataDir ?? ctx.workspace?.path ?? `/tmp/skelm-gw-${port}`)
        const configFile = typeof opts.configFile === 'function'
          ? opts.configFile(ctx)
          : opts.configFile

        // Start detached
        await ctx.exec!({
          command: 'skelm',
          args: [
            'gateway', 'start', '--detach',
            '--http-port', String(port),
            '--data-dir', dataDir,
            ...(configFile !== undefined ? ['--config', configFile] : []),
          ],
          throwOnNonZero: true,
        })

        // Poll for readiness
        const timeoutMs = opts.startupTimeoutMs ?? 15_000
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          try {
            const r = await ctx.exec!({
              command: 'curl',
              args: ['-sf', `http://localhost:${port}/healthz`],
              timeoutMs: 500,
            })
            if (r.exitCode === 0) {
              // Get PID from lockfile for reporting
              const pidR = await ctx.exec!({
                command: 'skelm',
                args: ['gateway', 'status', '--json'],
              }).catch(() => ({ stdout: '{}' }))
              const info = JSON.parse(pidR.stdout || '{}') as { pid?: number }
              return { pid: info.pid ?? -1, port }
            }
          } catch { /* keep polling */ }
          await new Promise((r) => setTimeout(r, 250))
        }
        throw new Error(
          `gatewayFixture: gateway on port ${port} did not become ready within ${timeoutMs}ms`,
        )
      },
    }),

    stop: () => code({
      id: `gateway-stop-${port}`,
      continueOnError: true,    // always attempt stop even if earlier steps failed
      permissions: testExecPermissions,
      run: async (ctx) => {
        const start = Date.now()
        await ctx.exec!({
          command: 'skelm',
          args: ['gateway', 'stop'],
        }).catch(() => {
          // Already stopped — fine.
        })
        return { durationMs: Date.now() - start }
      },
    }),
  }
}
```

---

## Part 3 — Workflow Structure

### `test-runner.workflow.mts` (orchestrator)

```typescript
import { invoke, parallel, pipeline, z } from 'skelm'
import { summarizeSections, type SummaryReport } from '@skelm/core/testing'

const START = Date.now()
const SECTION_IDS = [
  's00-preconditions',
  's01-build-and-static',
  's02-cli-surface',
  's03-workflow-execution',
  's05-gateway-http',
  's06-sse-polling',
  's08-permissions',
  's10-secrets',
  's15-control-flow',
  's28-gateway-lifecycle',
  's33-fresh-install',
]

export default pipeline({
  id: 'test-runner',
  description: 'Full skelm E2E live test pass',

  steps: [
    parallel({
      id: 'sections',
      onError: 'continue',    // never abort on section failures
      steps: SECTION_IDS.map((id) =>
        invoke({
          id,
          pipelineId: `sections/${id}`,
          input: () => ({}),
          continueOnError: true,
        })
      ),
    }),
  ],

  finalize: (ctx) => {
    return summarizeSections(SECTION_IDS, ctx, START)
  },
})
```

### Example section: `sections/s03-workflow-execution.workflow.mts`

```typescript
import { check, code, pipeline, z } from 'skelm'
import {
  summarizeChecks,
  testExecPermissions,
  type SectionResult,
} from '@skelm/core/testing'

const START = Date.now()
const CHECK_IDS = ['hello', 'sum', 'parallel', 'plain-input', 'branch', 'loop']

export default pipeline({
  id: 's03-workflow-execution',
  description: 'Section 03 — workflow execution (example fixtures)',

  steps: [
    check({
      id: 'hello',
      description: 'hello.workflow.mts returns expected greeting',
      permissions: testExecPermissions,
      run: async (ctx) => {
        const r = await ctx.exec!({
          command: 'skelm',
          args: ['run', 'examples/hello/hello.workflow.mts', '--input', '{"name":"World"}'],
          throwOnNonZero: true,
        })
        const out = JSON.parse(r.stdout.trim())
        if (out.greeting !== 'hello, World') {
          throw new Error(`expected 'hello, World', got '${out.greeting}'`)
        }
        return out
      },
    }),

    check({
      id: 'sum',
      description: 'sum.workflow.mts returns 8 for a=3, b=5',
      permissions: testExecPermissions,
      run: async (ctx) => {
        const r = await ctx.exec!({
          command: 'skelm',
          args: ['run', 'examples/sum/sum.workflow.mts', '--input', '{"a":3,"b":5}'],
          throwOnNonZero: true,
        })
        const out = JSON.parse(r.stdout.trim())
        if (out.sum !== 8) throw new Error(`expected sum=8, got ${out.sum}`)
        return out
      },
    }),

    check({
      id: 'parallel',
      description: 'parallel.workflow.mts runs both arms',
      permissions: testExecPermissions,
      run: async (ctx) => {
        const r = await ctx.exec!({
          command: 'skelm',
          args: ['run', 'test_plan/fixtures/parallel.workflow.ts', '--input', '{}'],
          throwOnNonZero: true,
        })
        const out = JSON.parse(r.stdout.trim())
        if (out.a !== 'result-a' || out.b !== 'result-b') {
          throw new Error(`unexpected parallel output: ${JSON.stringify(out)}`)
        }
        return out
      },
    }),

    // ... more checks ...
  ],

  finalize: (ctx) => summarizeChecks('s03-workflow-execution', CHECK_IDS, ctx, START),
})
```

### Example section with gateway: `sections/s05-gateway-http.workflow.mts`

```typescript
import { check, code, pipeline } from 'skelm'
import {
  gatewayFixture,
  probeHttp,
  summarizeChecks,
  testExecPermissions,
  type SectionResult,
} from '@skelm/core/testing'

const START = Date.now()
const PORT = 4099
const GW_URL = `http://localhost:${PORT}`
const gw = gatewayFixture({ port: PORT })

const CHECK_IDS = ['healthz', 'list-pipelines', 'run-hello', 'list-runs']

export default pipeline({
  id: 's05-gateway-http',
  description: 'Section 05 — gateway HTTP surface',
  workspace: { mode: 'ephemeral', cleanup: 'on-run-end' },

  steps: [
    gw.start(),

    check({
      id: 'healthz',
      description: 'GET /healthz returns 200',
      permissions: testExecPermissions,
      run: async (ctx) => {
        const r = await ctx.exec!({
          command: 'curl', args: ['-sf', `${GW_URL}/healthz`],
          throwOnNonZero: true,
        })
        return JSON.parse(r.stdout)
      },
    }),

    check({
      id: 'list-pipelines',
      description: 'GET /v1/pipelines returns array',
      permissions: testExecPermissions,
      run: async (ctx) => {
        const r = await ctx.exec!({
          command: 'curl', args: ['-sf', `${GW_URL}/v1/pipelines`],
          throwOnNonZero: true,
        })
        const body = JSON.parse(r.stdout)
        if (!Array.isArray(body)) throw new Error('expected array')
        return { count: body.length }
      },
    }),

    check({
      id: 'run-hello',
      description: 'POST /v1/pipelines/hello/run returns completed run',
      permissions: testExecPermissions,
      run: async (ctx) => {
        const r = await ctx.exec!({
          command: 'curl',
          args: ['-sf', '-X', 'POST', `${GW_URL}/v1/pipelines/hello/run`,
            '-H', 'Content-Type: application/json',
            '-d', '{"input":{"name":"World"}}'],
          throwOnNonZero: true,
        })
        const run = JSON.parse(r.stdout)
        if (run.status !== 'completed') throw new Error(`run status: ${run.status}`)
        return { runId: run.runId, output: run.output }
      },
    }),

    check({
      id: 'list-runs',
      description: 'GET /v1/runs returns array with at least one run',
      permissions: testExecPermissions,
      run: async (ctx) => {
        const r = await ctx.exec!({
          command: 'curl', args: ['-sf', `${GW_URL}/v1/runs`],
          throwOnNonZero: true,
        })
        const body = JSON.parse(r.stdout)
        if (!Array.isArray(body) || body.length === 0) throw new Error('expected non-empty array')
        return { count: body.length }
      },
    }),

    gw.stop(),
  ],

  finalize: (ctx) => summarizeChecks('s05-gateway-http', CHECK_IDS, ctx, START),
})
```

---

## Part 4 — Phased Delivery Plan

### Phase A — Runtime changes (1 PR)

**What:** `continueOnError` + `workspace` on `code()` steps.

**Files changed:**
- `packages/core/src/types.ts` — add fields to step interfaces
- `packages/core/src/builders.ts` — pass fields through
- `packages/core/src/runner.ts` — `continue` instead of `break` when `continueOnError`
- `packages/core/src/execution/handlers.ts` — workspace provisioning in `runCodeStep`
- Tests: new vitest cases for `continueOnError` behavior; `code()` workspace provisioning

**Acceptance criteria:**
- `pnpm check` green
- A pipeline with `continueOnError: true` on step 2 of 3 runs all 3 steps when step 2 throws
- A `code()` step with `workspace: { mode: 'ephemeral' }` gets `ctx.workspace.path`
- Existing pipeline behavior (no `continueOnError`) is unchanged — single test verifying break-on-error still works

**PR title:** `feat(core): continueOnError on pipeline steps + workspace on code() steps`

---

### Phase B — Testing library additions (1 PR, depends on Phase A)

**What:** `check()`, `TestResult`, `SectionResult`, `SummaryReport`, `summarizeChecks()`,
`summarizeSections()`, `testExecPermissions`, `probeHttp()`, `GatewayFixture`.

**Files changed:**
- `packages/core/src/builders.ts` — `check()` builder
- `packages/core/src/testing.ts` — all new types + helpers
- `packages/core/src/index.ts` — re-export `check` from builders
- Tests: unit tests for `summarizeChecks`, `summarizeSections`, `probeHttp` (mock exec)

**Acceptance criteria:**
- `check()` step that throws returns `TestResult { status: 'fail' }` in ctx.steps
- `check()` step that succeeds returns `TestResult { status: 'pass' }` with correct durationMs
- `summarizeChecks()` correctly counts pass/fail/skip across mixed results
- `testExecPermissions` is exported and typed as `AgentPermissions`
- All new exports appear in `@skelm/core/testing` entrypoint

**PR title:** `feat(testing): check(), TestResult, SectionResult, probeHttp, GatewayFixture`

---

### Phase C — First test workflows (1 PR, depends on Phase B)

**What:** Convert sections 00–05 from markdown to skelm workflows in `skelm.test/`.

**Files created** (in `~/sandbox/personal/skelm.test/`):
```
workflows/
  test-runner.workflow.mts
  sections/
    s00-preconditions.workflow.mts
    s01-build-and-static.workflow.mts
    s02-cli-surface.workflow.mts
    s03-workflow-execution.workflow.mts
    s05-gateway-http.workflow.mts
  lib/
    constants.mts           # GW_URL, ports, paths
    assertions.mts          # shared assertJsonContains, assertExitCode helpers
```

**Acceptance criteria:**
- `skelm run workflows/test-runner.workflow.mts` runs all 5 sections, emits `SummaryReport`
- Sections 00–03 pass green on a clean build
- Section 05 starts a gateway on port 4099, runs its checks, stops the gateway
- `SummaryReport` printed to stdout with section breakdown

---

### Phase D — Remaining sections (multiple PRs, depends on Phase C)

Convert sections 06–71 in batches grouped by feature area. Each batch is one PR.

| Batch | Sections | Grouping |
|-------|----------|----------|
| D1 | 06, 07, 08 | SSE, webhooks, permissions |
| D2 | 10, 11, 12 | Secrets, workspace, debug |
| D3 | 13, 14 | Sessions, ACP |
| D4 | 15, 16, 17 | Control flow, vercel-ai, opencode |
| D5 | 19, 20, 21, 22 | Native agent, invoke, MCP, extended |
| D6 | 23, 24, 25 | Codex, gateway v1 API, system prompt |
| D7 | 26–30 | Control flow nesting, complex workflows, lifecycle, CLI conflicts, triggers |
| D8 | 31–35 | Reload, wait durability, fresh install, code module, custom integrations |
| D9 | 36–42 | when, workspace git-repo, GitHub REST, dedupe, threads, github-pr, PR review e2e |
| D10 | 43–71 | All remaining (cron tz, interval, file-watch, webhook providers, multimodal, vision, ...) |

---

### Phase E — CI integration (1 PR, depends on Phase D partial)

**What:** Add a `github-pr` trigger so the test runner fires on every push to `scottgl9/skelm`.

**Files changed:**
- `skelm.test/workflows/test-runner.workflow.mts` — add `triggers` array
- `skelm.test/skelm.config.mts` — add `github-pr` backend config + secrets

```typescript
// In test-runner.workflow.mts
triggers: [
  {
    kind: 'github-pr',
    id: 'on-pr',
    path: '/hooks/github/skelm-prs',
    secret: { env: 'GITHUB_WEBHOOK_SECRET' },
    events: ['opened', 'synchronize'],
    filter: { repos: ['scottgl9/skelm'] },
  },
  {
    kind: 'cron',
    id: 'nightly',
    cron: '0 2 * * *',   // 2am daily
  },
]
```

**Acceptance criteria:**
- Push to `scottgl9/skelm` fires the test runner on the local gateway
- Results posted back as a PR comment via `@skelm/integrations` GitHub REST
- Nightly cron fires and results are stored/accessible

---

## Part 5 — Success Criteria

The project is complete when:

1. `skelm run workflows/test-runner.workflow.mts` runs without human intervention and
   produces a `SummaryReport` covering all 71 sections.

2. The report format is:
   ```
   skelm E2E Pass — 2026-05-22T14:30:00Z
   ✅ 342 pass  ❌ 0 fail  ⏭ 3 skip  (4m 12s)

   s00-preconditions     ✅  7/7  (0.8s)
   s01-build-and-static  ✅  5/5  (28.4s)
   s02-cli-surface       ✅ 12/12 (3.1s)
   ...
   ```

3. A `github-pr` trigger fires the runner on every push to `scottgl9/skelm` and posts
   results as a PR check comment.

4. Total wall-clock time ≤ 8 minutes (parallel section execution, gateway lifecycle
   sections on isolated ports to prevent conflicts).

---

## Part 6 — Open Questions

1. **Section isolation:** Sections that start a gateway need their own port. We need a
   port allocation scheme that's deterministic (section id → port offset) and doesn't
   conflict. Proposed: `BASE_PORT + section_number` (e.g. section 05 → 4005,
   section 28 → 4028). Sections that don't need a gateway use a shared read-only
   gateway started once by the orchestrator.

2. **`check()` vs `code()` for setup steps:** Not every step in a section is a test
   assertion — some are setup (start gateway, set secrets, clone repo). These should
   be `code()` steps, not `check()` steps. The `finalize` should only collect the
   `check()` step ids into `SectionResult`, not setup steps. The `CHECK_IDS` array
   in each section's `finalize` call makes this explicit.

3. **Multimodal / backend-specific sections:** Sections 09 (Pi), 16 (vercel-ai), 17
   (opencode), 23 (codex) require specific backends to be available. Use `when:`
   predicates gated on env vars (same as current `SKELM_CODEX_INTEGRATION=1` pattern)
   to skip gracefully when the backend isn't configured.

4. **`parallel()` + `wait()` constraint:** The note in `assertNoWaitInside` applies —
   sections that contain `wait()` steps cannot be run inside the top-level
   `parallel()`. Section 32 (wait durability) must be run sequentially. The orchestrator
   can run non-wait sections in parallel and wait-containing sections sequentially after.

5. **Result storage:** `SummaryReport` is the pipeline output, stored in the run store.
   For the CI case, we also want to post it as a GitHub PR comment. That's a follow-up
   step in the orchestrator (an `llm()` or `code()` step that formats and posts the
   comment via `@skelm/integrations` GitHub REST).
