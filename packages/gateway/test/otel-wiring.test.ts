/**
 * Plan §4.1 (otel half): when enableOtel:true the gateway attaches the
 * @skelm/otel collector to per-run EventBuses, producing run + step
 * spans. SDK choice (exporter / sampler / resource) is the host's
 * responsibility — we test only that the attachment plumbing wires
 * through, not the OTel SDK itself.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Context, type Span, type SpanOptions, type Tracer, trace } from '@opentelemetry/api'
import { code, pipeline } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Gateway } from '../src/index.js'

let stateDir: string

interface RecordedSpan {
  name: string
  attributes: Record<string, unknown>
}

function captureTracer(spans: RecordedSpan[]): Tracer {
  // Minimal Tracer that records each startSpan name+attrs. The runtime
  // calls .startSpan(name, opts, ctx) and later .end()/.setAttribute() etc.;
  // we only need to capture the construction.
  const fakeSpan = (rec: RecordedSpan): Span =>
    ({
      end: () => {},
      isRecording: () => true,
      recordException: () => {},
      setStatus: () => fakeSpan(rec),
      updateName: () => fakeSpan(rec),
      setAttribute: (k: string, v: unknown) => {
        rec.attributes[k] = v
        return fakeSpan(rec)
      },
      setAttributes: (a: Record<string, unknown>) => {
        Object.assign(rec.attributes, a)
        return fakeSpan(rec)
      },
      addEvent: () => fakeSpan(rec),
      addLink: () => fakeSpan(rec),
      addLinks: () => fakeSpan(rec),
      spanContext: () => ({
        traceId: '0'.repeat(32),
        spanId: '0'.repeat(16),
        traceFlags: 1,
      }),
    }) as unknown as Span
  return {
    startSpan: (name: string, opts?: SpanOptions) => {
      const rec: RecordedSpan = {
        name,
        attributes: { ...(opts?.attributes ?? {}) } as Record<string, unknown>,
      }
      spans.push(rec)
      return fakeSpan(rec)
    },
    startActiveSpan: ((...args: unknown[]) => {
      // The runtime never calls startActiveSpan in @skelm/otel; keep a stub.
      const fn = args[args.length - 1] as (s: Span) => unknown
      const rec: RecordedSpan = { name: String(args[0] ?? ''), attributes: {} }
      spans.push(rec)
      return fn(fakeSpan(rec))
    }) as Tracer['startActiveSpan'],
  }
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-otel-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(stateDir, { recursive: true, force: true })
})

describe('gateway OpenTelemetry wiring (plan §4.1)', () => {
  it('attaches the otel collector so run + step spans fire when enableOtel:true', async () => {
    const spans: RecordedSpan[] = []
    vi.spyOn(trace, 'getTracer').mockReturnValue(captureTracer(spans))

    const gw = new Gateway({
      stateDir,
      enableHttp: false,
      watchRegistries: false,
      enableOtel: true,
      config: {},
    })
    await gw.start()
    try {
      const wf = pipeline({
        id: 'otel-test',
        steps: [code({ id: 'work', run: () => ({ ok: 1 }) })],
      })
      const { Runner } = await import('@skelm/core')
      const runner = new Runner({ store: gw.runStore })
      gw.attachOtelBus(runner.events)
      const handle = runner.start(wf, undefined)
      await handle.wait()
    } finally {
      await gw.stop()
    }

    const runSpan = spans.find((s) => s.name === 'run:otel-test')
    expect(runSpan, 'expected one run:<pipelineId> span').toBeDefined()
    expect(runSpan?.attributes['skelm.pipeline.id']).toBe('otel-test')

    const stepSpan = spans.find((s) => s.name === 'step:work')
    expect(stepSpan, 'expected one step:<stepId> span').toBeDefined()
  })

  it('attachOtelBus is a no-op when enableOtel is omitted', async () => {
    const spans: RecordedSpan[] = []
    vi.spyOn(trace, 'getTracer').mockReturnValue(captureTracer(spans))

    const gw = new Gateway({
      stateDir,
      enableHttp: false,
      watchRegistries: false,
      config: {},
    })
    await gw.start()
    try {
      const wf = pipeline({
        id: 'no-otel',
        steps: [code({ id: 'work', run: () => ({}) })],
      })
      const { Runner } = await import('@skelm/core')
      const runner = new Runner({ store: gw.runStore })
      gw.attachOtelBus(runner.events) // No-op when otel disabled.
      const handle = runner.start(wf, undefined)
      await handle.wait()
    } finally {
      await gw.stop()
    }
    expect(spans.filter((s) => s.name.startsWith('run:'))).toHaveLength(0)
  })
})
