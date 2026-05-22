import { describe, expect, it } from 'vitest'
import { check, pipeline } from '../src/builders.js'
import type { TestResult } from '../src/builders.js'
import { runPipeline } from '../src/runner.js'
import {
  type SectionResult,
  type SummaryReport,
  gatewayFixture,
  probeHttp,
  summarizeChecks,
  summarizeSections,
  testExecPermissions,
} from '../src/testing.js'

describe('check()', () => {
  it('records a pass TestResult when run returns a value', async () => {
    const wf = pipeline<unknown, TestResult>({
      id: 'check-pass',
      steps: [check({ id: 'a', run: () => 'ok' })],
      finalize: (ctx) => ctx.get<TestResult>('a') as TestResult,
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    const out = run.output as TestResult
    expect(out.status).toBe('pass')
    expect(out.actual).toBe('ok')
    expect(out.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('records a fail TestResult when run throws, and pipeline continues', async () => {
    const wf = pipeline<unknown, { a?: TestResult; b?: TestResult }>({
      id: 'check-fail-continues',
      steps: [
        check({
          id: 'a',
          run: () => {
            throw new Error('nope')
          },
        }),
        check({ id: 'b', run: () => 2 }),
      ],
      finalize: (ctx) => ({
        a: ctx.get<TestResult>('a'),
        b: ctx.get<TestResult>('b'),
      }),
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    const out = run.output as { a: TestResult; b: TestResult }
    expect(out.a.status).toBe('fail')
    expect(out.a.message).toBe('nope')
    expect(out.b.status).toBe('pass')
    expect(out.b.actual).toBe(2)
  })
})

describe('summarizeChecks()', () => {
  it('aggregates pass/fail/skip across check outputs and a missing id', async () => {
    const wf = pipeline<unknown, SectionResult>({
      id: 's',
      steps: [
        check({ id: 'pass1', run: () => 1 }),
        check({
          id: 'fail1',
          run: () => {
            throw new Error('boom')
          },
        }),
        check({ id: 'pass2', run: () => 2 }),
      ],
      finalize: (ctx) => summarizeChecks('s', ['pass1', 'fail1', 'pass2', 'missing'], ctx, 0),
    })
    const run = await runPipeline(wf, undefined)
    const out = run.output as SectionResult
    expect(out.sectionId).toBe('s')
    expect(out.passCount).toBe(2)
    expect(out.failCount).toBe(1)
    expect(out.skipCount).toBe(1)
    expect(out.status).toBe('fail')
    expect(out.checks.map((c) => c.id)).toEqual(['pass1', 'fail1', 'pass2', 'missing'])
    expect(out.checks[3]?.status).toBe('skip')
  })

  it('returns status=pass when there are no failures', async () => {
    const wf = pipeline<unknown, SectionResult>({
      id: 's',
      steps: [check({ id: 'a', run: () => 1 })],
      finalize: (ctx) => summarizeChecks('s', ['a'], ctx, Date.now()),
    })
    const run = await runPipeline(wf, undefined)
    const out = run.output as SectionResult
    expect(out.status).toBe('pass')
    expect(out.failCount).toBe(0)
  })

  it('returns status=skip when every check is missing', () => {
    const fakeCtx = { get: () => undefined } as unknown as Parameters<typeof summarizeChecks>[2]
    const result = summarizeChecks('s', ['x', 'y'], fakeCtx, 0)
    expect(result.status).toBe('skip')
    expect(result.skipCount).toBe(2)
  })
})

describe('summarizeSections()', () => {
  it('aggregates SectionResult values across sections', () => {
    const fakeCtx = {
      get: <T>(id: string): T | undefined => {
        if (id === 's1') {
          return {
            sectionId: 's1',
            checks: [],
            passCount: 3,
            failCount: 0,
            skipCount: 0,
            durationMs: 10,
            status: 'pass',
          } as unknown as T
        }
        if (id === 's2') {
          return {
            sectionId: 's2',
            checks: [],
            passCount: 1,
            failCount: 2,
            skipCount: 0,
            durationMs: 20,
            status: 'fail',
          } as unknown as T
        }
        return undefined
      },
    } as unknown as Parameters<typeof summarizeSections>[1]

    const summary: SummaryReport = summarizeSections(['s1', 's2', 's3-missing'], fakeCtx, 0)
    expect(summary.totalPass).toBe(4)
    expect(summary.totalFail).toBe(2)
    expect(summary.totalSkip).toBe(0)
    expect(summary.status).toBe('fail')
    expect(summary.sections[2]?.status).toBe('skip')
  })

  it('reports overall pass when no section has any failures', () => {
    const fakeCtx = {
      get: <T>(): T | undefined =>
        ({
          sectionId: 'x',
          checks: [],
          passCount: 1,
          failCount: 0,
          skipCount: 0,
          durationMs: 1,
          status: 'pass',
        }) as unknown as T,
    } as unknown as Parameters<typeof summarizeSections>[1]
    const summary = summarizeSections(['x'], fakeCtx, 0)
    expect(summary.status).toBe('pass')
  })
})

describe('testExecPermissions', () => {
  it('includes the standard test toolset and allows egress', () => {
    expect(testExecPermissions.allowedExecutables).toEqual(
      expect.arrayContaining(['skelm', 'node', 'curl', 'gh', 'pnpm', 'git', 'bash', 'sh', 'jq']),
    )
    expect(testExecPermissions.networkEgress).toBe('allow')
  })
})

describe('probeHttp()', () => {
  it('returns when ctx.exec reports the expected status', async () => {
    const step = probeHttp({ id: 'probe', url: 'http://example.test/healthz', pollMs: 1 })
    let calls = 0
    const ctx = {
      exec: async () => {
        calls += 1
        return {
          stdout: calls < 2 ? '000' : '200',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          durationMs: 0,
        }
      },
    } as unknown as Parameters<NonNullable<typeof step.run>>[0]
    const result = (await step.run?.(ctx)) as { status: number; durationMs: number }
    expect(result.status).toBe(200)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('throws with a deadline message when the status never matches', async () => {
    const step = probeHttp({
      id: 'probe',
      url: 'http://example.test/never',
      timeoutMs: 30,
      pollMs: 1,
    })
    const ctx = {
      exec: async () => ({
        stdout: '500',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
      }),
    } as unknown as Parameters<NonNullable<typeof step.run>>[0]
    await expect(step.run?.(ctx)).rejects.toThrow(/did not return 200 within 30ms/)
  })
})

describe('gatewayFixture()', () => {
  it('passes SKELM_STATE_DIR=<dataDir> to skelm gateway start (per-port isolation)', async () => {
    const gw = gatewayFixture({ port: 4131, dataDir: '/tmp/gw-test-4131' })
    const step = gw.start()
    const execCalls: { args?: readonly string[]; env?: Record<string, string> }[] = []
    let curlCalls = 0
    const ctx = {
      exec: async (req: { args?: readonly string[]; env?: Record<string, string> }) => {
        execCalls.push(req)
        if (req.args?.[0] === 'gateway' && req.args[1] === 'start') {
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false, durationMs: 0 }
        }
        if (req.args?.[0] === '-sf') {
          // first poll fails, second succeeds
          curlCalls += 1
          return {
            stdout: '',
            stderr: '',
            exitCode: curlCalls < 2 ? 1 : 0,
            timedOut: false,
            durationMs: 0,
          }
        }
        // gateway status --json
        return {
          stdout: JSON.stringify({ pid: 12345 }),
          stderr: '',
          exitCode: 0,
          timedOut: false,
          durationMs: 0,
        }
      },
    } as unknown as Parameters<NonNullable<typeof step.run>>[0]

    const result = (await step.run?.(ctx)) as {
      pid: number
      port: number
      dataDir: string
    }
    expect(result.port).toBe(4131)
    expect(result.dataDir).toBe('/tmp/gw-test-4131')
    expect(result.pid).toBe(12345)

    const startCall = execCalls.find((c) => c.args?.[0] === 'gateway' && c.args?.[1] === 'start')
    expect(startCall).toBeDefined()
    expect(startCall?.env?.SKELM_STATE_DIR).toBe('/tmp/gw-test-4131')
    // Confirm we did NOT pass the unsupported --data-dir flag
    expect(startCall?.args).not.toContain('--data-dir')
    expect(startCall?.args).toContain('--detach')
    expect(startCall?.args).toContain('--http-port')
  })

  it('stop() passes SKELM_STATE_DIR matching the same fixture', async () => {
    const gw = gatewayFixture({ port: 4132, dataDir: '/tmp/gw-test-4132' })
    const step = gw.stop()
    const execCalls: { args?: readonly string[]; env?: Record<string, string> }[] = []
    const ctx = {
      exec: async (req: { args?: readonly string[]; env?: Record<string, string> }) => {
        execCalls.push(req)
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, durationMs: 0 }
      },
    } as unknown as Parameters<NonNullable<typeof step.run>>[0]

    await step.run?.(ctx)
    const stopCall = execCalls.find((c) => c.args?.[1] === 'stop')
    expect(stopCall).toBeDefined()
    expect(stopCall?.env?.SKELM_STATE_DIR).toBe('/tmp/gw-test-4132')
  })
})
