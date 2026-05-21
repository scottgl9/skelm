import {
  type Attributes,
  type Span,
  SpanStatusCode,
  type Tracer,
  context,
  trace,
} from '@opentelemetry/api'
import { EventBus, type RunEvent } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { attachOpenTelemetry } from '../src/index.js'

// Coverage focus: failure / cancel / tool / permission / dispose paths.
// The colocated happy-path test in src/ covered run.completed + wait;
// these fill in the rest of the event→span mapping.

interface RecordedSpan {
  name: string
  ended: boolean
  attributes: Record<string, unknown>
  events: Array<{ name: string; attributes?: Attributes }>
  status: { code: SpanStatusCode; message?: string } | null
  exceptions: unknown[]
}

function makeRecorder(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = []
  const tracer = {
    startSpan(name: string, options?: { attributes?: Attributes }) {
      const record: RecordedSpan = {
        name,
        ended: false,
        attributes: { ...(options?.attributes ?? {}) },
        events: [],
        status: null,
        exceptions: [],
      }
      const span = {
        spanContext: () => ({
          traceId: '0'.repeat(32),
          spanId: String(spans.length + 1).padStart(16, '0'),
          traceFlags: 1,
        }),
        setAttribute: (k: string, v: unknown) => {
          record.attributes[k] = v
          return span
        },
        setAttributes: (attrs: Attributes) => {
          Object.assign(record.attributes, attrs)
          return span
        },
        addEvent: (n: string, attrs?: Attributes) => {
          record.events.push({ name: n, ...(attrs !== undefined && { attributes: attrs }) })
          return span
        },
        recordException: (err: unknown) => {
          record.exceptions.push(err)
          return span
        },
        setStatus: (status: { code: SpanStatusCode; message?: string }) => {
          record.status = status
          return span
        },
        updateName: () => span,
        end: () => {
          record.ended = true
        },
        isRecording: () => true,
      } as unknown as Span
      spans.push(record)
      return span
    },
  } as unknown as Tracer
  return { tracer, spans }
}

function emit(bus: EventBus, events: RunEvent[]): void {
  for (const e of events) bus.publish(e)
}

const RUN_ID = 'r1'
const STEP_ID = 's1'

function lifecycle(extra: RunEvent[]): RunEvent[] {
  const at = 1
  return [
    { type: 'run.created', runId: RUN_ID, pipelineId: 'p', input: null, at },
    { type: 'run.started', runId: RUN_ID, at },
    { type: 'step.start', runId: RUN_ID, stepId: STEP_ID, kind: 'code', at },
    ...extra,
  ]
}

describe('@skelm/otel — error and tool mappings', () => {
  it('marks step span as ERROR on step.error and records the exception', () => {
    const bus = new EventBus()
    const { tracer, spans } = makeRecorder()
    const att = attachOpenTelemetry(bus, { tracer })
    emit(bus, [
      ...lifecycle([
        {
          type: 'step.error',
          runId: RUN_ID,
          stepId: STEP_ID,
          kind: 'code',
          error: { name: 'BadError', message: 'boom' },
          at: 2,
        },
      ]),
    ])
    att.dispose()
    const stepSpan = spans.find((s) => s.name === `step:${STEP_ID}`)
    expect(stepSpan?.status?.code).toBe(SpanStatusCode.ERROR)
    expect(stepSpan?.exceptions).toEqual([{ name: 'BadError', message: 'boom' }])
    expect(stepSpan?.attributes['skelm.step.status']).toBe('failed')
  })

  it('marks run span as ERROR on run.failed', () => {
    const bus = new EventBus()
    const { tracer, spans } = makeRecorder()
    const att = attachOpenTelemetry(bus, { tracer })
    emit(bus, [
      ...lifecycle([]),
      {
        type: 'run.failed',
        runId: RUN_ID,
        error: { name: 'X', message: 'nope' },
        at: 9,
      },
    ])
    att.dispose()
    const runSpan = spans.find((s) => s.name === 'run:p')
    expect(runSpan?.status?.code).toBe(SpanStatusCode.ERROR)
    expect(runSpan?.attributes['skelm.run.status']).toBe('failed')
    expect(runSpan?.exceptions).toEqual([{ name: 'X', message: 'nope' }])
  })

  it('records run.cancelled with attribute and event', () => {
    const bus = new EventBus()
    const { tracer, spans } = makeRecorder()
    const att = attachOpenTelemetry(bus, { tracer })
    emit(bus, [...lifecycle([]), { type: 'run.cancelled', runId: RUN_ID, at: 9 }])
    att.dispose()
    const runSpan = spans.find((s) => s.name === 'run:p')
    expect(runSpan?.attributes['skelm.run.status']).toBe('cancelled')
    expect(runSpan?.events.map((e) => e.name)).toContain('run.cancelled')
  })

  it('attaches tool.call / tool.result / tool.denied as step events', () => {
    const bus = new EventBus()
    const { tracer, spans } = makeRecorder()
    const att = attachOpenTelemetry(bus, { tracer })
    emit(bus, [
      ...lifecycle([
        {
          type: 'tool.call',
          runId: RUN_ID,
          stepId: STEP_ID,
          tool: 'shell.exec',
          arguments: {},
          at: 3,
        },
        {
          type: 'tool.result',
          runId: RUN_ID,
          stepId: STEP_ID,
          tool: 'shell.exec',
          result: { ok: true },
          durationMs: 12,
          at: 4,
        },
        {
          type: 'tool.denied',
          runId: RUN_ID,
          stepId: STEP_ID,
          tool: 'shell.exec',
          reason: 'not-in-allowlist',
          at: 5,
        },
      ]),
    ])
    att.dispose()
    const stepSpan = spans.find((s) => s.name === `step:${STEP_ID}`)
    const names = stepSpan?.events.map((e) => e.name) ?? []
    expect(names).toEqual(expect.arrayContaining(['tool.call', 'tool.result', 'tool.denied']))
    const denied = stepSpan?.events.find((e) => e.name === 'tool.denied')
    expect(denied?.attributes).toMatchObject({
      'skelm.tool.id': 'shell.exec',
      'skelm.permission.reason': 'not-in-allowlist',
    })
  })

  it('attaches permission.denied with the dimension attribute', () => {
    const bus = new EventBus()
    const { tracer, spans } = makeRecorder()
    const att = attachOpenTelemetry(bus, { tracer })
    emit(bus, [
      ...lifecycle([
        {
          type: 'permission.denied',
          runId: RUN_ID,
          stepId: STEP_ID,
          dimension: 'executable',
          detail: 'no bash',
          at: 3,
        },
      ]),
    ])
    att.dispose()
    const stepSpan = spans.find((s) => s.name === `step:${STEP_ID}`)
    const denied = stepSpan?.events.find((e) => e.name === 'permission.denied')
    expect(denied?.attributes).toMatchObject({ 'skelm.permission.dimension': 'executable' })
  })

  it('dispose() ends in-flight spans', () => {
    const bus = new EventBus()
    const { tracer, spans } = makeRecorder()
    const att = attachOpenTelemetry(bus, { tracer })
    emit(bus, lifecycle([]))
    expect(spans.every((s) => s.ended)).toBe(false)
    att.dispose()
    expect(spans.every((s) => s.ended)).toBe(true)
  })

  it('unsubscribes on dispose — later events are ignored', () => {
    const bus = new EventBus()
    const { tracer, spans } = makeRecorder()
    const att = attachOpenTelemetry(bus, { tracer })
    att.dispose()
    emit(bus, lifecycle([]))
    expect(spans).toHaveLength(0)
  })
})
