import { type Span, type Tracer, context, trace } from '@opentelemetry/api'
import { EventBus, code, pipeline, runPipeline, wait } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import { attachOpenTelemetry } from './index.js'

describe('@skelm/otel', () => {
  it('creates parented run and step spans from runtime events', async () => {
    const bus = new EventBus()
    const recorder = createRecordingTracer()
    const attachment = attachOpenTelemetry(bus, { tracer: recorder.tracer })

    const wf = pipeline({
      id: 'otel-success',
      steps: [code({ id: 'work', run: () => ({ ok: true }) })],
    })

    try {
      const run = await runPipeline(wf, undefined, { events: bus })
      expect(run.status).toBe('completed')
    } finally {
      attachment.dispose()
    }

    expect(recorder.records).toHaveLength(2)
    const runSpan = recorder.records.find((record) => record.name === 'run:otel-success')
    const stepSpan = recorder.records.find((record) => record.name === 'step:work')
    expect(runSpan).toEqual(
      expect.objectContaining({
        ended: true,
        attributes: expect.objectContaining({
          'skelm.pipeline.id': 'otel-success',
          'skelm.run.status': 'completed',
        }),
      }),
    )
    expect(stepSpan).toEqual(
      expect.objectContaining({
        ended: true,
        parentName: 'run:otel-success',
        attributes: expect.objectContaining({
          'skelm.step.id': 'work',
          'skelm.step.kind': 'code',
          'skelm.step.status': 'completed',
        }),
      }),
    )
  })

  it('records wait lifecycle as step span events', async () => {
    const bus = new EventBus()
    const recorder = createRecordingTracer()
    const attachment = attachOpenTelemetry(bus, { tracer: recorder.tracer })

    const wf = pipeline({
      id: 'otel-wait',
      steps: [wait({ id: 'pause', message: 'approval required' })],
    })

    try {
      const run = await runPipeline(wf, undefined, {
        events: bus,
        waitForInput: async () => ({ approved: true }),
      })
      expect(run.status).toBe('completed')
    } finally {
      attachment.dispose()
    }

    const stepSpan = recorder.records.find((record) => record.name === 'step:pause')
    expect(stepSpan?.events.map((event) => event.name)).toEqual(
      expect.arrayContaining(['run.waiting', 'run.resumed']),
    )
  })
})

interface RecordedSpan {
  name: string
  parentName?: string
  ended: boolean
  attributes: Record<string, string | number | boolean>
  events: Array<{
    name: string
    attributes?: Record<string, string | number | boolean>
  }>
}

function createRecordingTracer(): {
  tracer: Tracer
  records: RecordedSpan[]
} {
  const records: RecordedSpan[] = []
  const tracer = {
    startSpan(
      name: string,
      options?: { attributes?: Record<string, string | number | boolean> },
      parent = context.active(),
    ) {
      const parentSpan = trace.getSpan(parent)
      const record: RecordedSpan = {
        name,
        ...(parentSpan !== undefined && {
          parentName: recorderName(parentSpan),
        }),
        ended: false,
        attributes: { ...(options?.attributes ?? {}) },
        events: [],
      }
      const span = {
        __name: name,
        spanContext: () => ({
          traceId: '00000000000000000000000000000001',
          spanId: String(records.length + 1).padStart(16, '0'),
          traceFlags: 1,
        }),
        setAttribute: (key: string, value: string | number | boolean) => {
          record.attributes[key] = value
          return span
        },
        setAttributes: (attributes: Record<string, string | number | boolean>) => {
          Object.assign(record.attributes, attributes)
          return span
        },
        addEvent: (eventName: string, attributes?: Record<string, string | number | boolean>) => {
          record.events.push({ name: eventName, ...(attributes !== undefined && { attributes }) })
          return span
        },
        recordException: () => span,
        setStatus: () => span,
        updateName: () => span,
        end: () => {
          record.ended = true
        },
        isRecording: () => true,
      } as unknown as Span & { __name: string }
      records.push(record)
      return span
    },
  } as unknown as Tracer
  return { tracer, records }
}

function recorderName(span: Span): string | undefined {
  if ('__name' in span && typeof span.__name === 'string') {
    return span.__name
  }
  return undefined
}
