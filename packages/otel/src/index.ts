import {
  type Attributes,
  type Context,
  type Span,
  SpanStatusCode,
  type Tracer,
  context,
  trace,
} from '@opentelemetry/api'
import type { EventBus } from '@skelm/core'
import type { RunEvent } from '@skelm/core'

export interface OpenTelemetryOptions {
  tracer?: Tracer
  tracerName?: string
}

export interface OpenTelemetryAttachment {
  dispose(): void
}

export function attachOpenTelemetry(
  events: Pick<EventBus, 'subscribe'>,
  opts: OpenTelemetryOptions = {},
): OpenTelemetryAttachment {
  const tracer = opts.tracer ?? trace.getTracer(opts.tracerName ?? '@skelm/otel')
  const runSpans = new Map<string, Span>()
  const runContexts = new Map<string, Context>()
  const stepSpans = new Map<string, Span>()
  const pipelines = new Map<string, string>()

  const unsubscribe = events.subscribe((event) => {
    switch (event.type) {
      case 'run.created': {
        pipelines.set(event.runId, event.pipelineId)
        const span = tracer.startSpan(
          `run:${event.pipelineId}`,
          {
            attributes: {
              'skelm.pipeline.id': event.pipelineId,
              'skelm.run.id': event.runId,
            },
            startTime: event.at,
          },
          context.active(),
        )
        runSpans.set(event.runId, span)
        runContexts.set(event.runId, trace.setSpan(context.active(), span))
        break
      }
      case 'run.started':
        addRunEvent(runSpans, event.runId, 'run.started')
        break
      case 'step.start': {
        const parentContext = runContexts.get(event.runId) ?? context.active()
        const span = tracer.startSpan(
          `step:${event.stepId}`,
          {
            attributes: {
              'skelm.run.id': event.runId,
              'skelm.step.id': event.stepId,
              'skelm.step.kind': event.kind,
              ...(pipelines.get(event.runId) !== undefined && {
                'skelm.pipeline.id': pipelines.get(event.runId),
              }),
            },
            startTime: event.at,
          },
          parentContext,
        )
        stepSpans.set(stepKey(event.runId, event.stepId), span)
        break
      }
      case 'step.complete': {
        const span = stepSpans.get(stepKey(event.runId, event.stepId))
        if (!span) break
        span.setAttribute('skelm.step.status', 'completed')
        span.setAttribute('skelm.step.duration_ms', event.durationMs)
        span.setStatus({ code: SpanStatusCode.OK })
        span.end(event.at)
        stepSpans.delete(stepKey(event.runId, event.stepId))
        break
      }
      case 'step.error': {
        const span = stepSpans.get(stepKey(event.runId, event.stepId))
        if (!span) break
        span.setAttribute('skelm.step.status', 'failed')
        span.recordException(event.error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: event.error.message })
        span.end(event.at)
        stepSpans.delete(stepKey(event.runId, event.stepId))
        break
      }
      case 'step.retry':
        addStepEvent(stepSpans, event.runId, event.stepId, 'step.retry', {
          'skelm.retry.attempt': event.attempt,
          ...(event.delayMs !== undefined && { 'skelm.retry.delay_ms': event.delayMs }),
        })
        break
      case 'run.waiting':
        addStepEvent(stepSpans, event.runId, event.stepId, 'run.waiting', {
          ...(event.timeoutMs !== undefined && { 'skelm.wait.timeout_ms': event.timeoutMs }),
        })
        break
      case 'run.resumed':
        addStepEvent(stepSpans, event.runId, event.stepId, 'run.resumed')
        break
      case 'tool.call':
        addStepEvent(stepSpans, event.runId, event.stepId, 'tool.call', {
          'skelm.tool.id': event.tool,
        })
        break
      case 'tool.result':
        addStepEvent(stepSpans, event.runId, event.stepId, 'tool.result', {
          'skelm.tool.id': event.tool,
          'skelm.tool.duration_ms': event.durationMs,
        })
        break
      case 'tool.denied':
        addStepEvent(stepSpans, event.runId, event.stepId, 'tool.denied', {
          'skelm.tool.id': event.tool,
          'skelm.permission.reason': event.reason,
        })
        break
      case 'permission.denied':
        addStepEvent(stepSpans, event.runId, event.stepId, 'permission.denied', {
          'skelm.permission.dimension': event.dimension,
        })
        break
      case 'run.completed': {
        const span = runSpans.get(event.runId)
        if (!span) break
        span.setAttribute('skelm.run.status', 'completed')
        span.setAttribute('skelm.run.duration_ms', event.durationMs)
        span.setStatus({ code: SpanStatusCode.OK })
        span.end(event.at)
        cleanupRun(event.runId, runSpans, runContexts, pipelines)
        break
      }
      case 'run.failed': {
        const span = runSpans.get(event.runId)
        if (!span) break
        span.setAttribute('skelm.run.status', 'failed')
        span.recordException(event.error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: event.error.message })
        span.end(event.at)
        cleanupRun(event.runId, runSpans, runContexts, pipelines)
        break
      }
      case 'run.cancelled': {
        const span = runSpans.get(event.runId)
        if (!span) break
        span.setAttribute('skelm.run.status', 'cancelled')
        span.addEvent('run.cancelled', undefined, event.at)
        span.end(event.at)
        cleanupRun(event.runId, runSpans, runContexts, pipelines)
        break
      }
    }
  })

  return {
    dispose(): void {
      unsubscribe()
      for (const span of stepSpans.values()) span.end()
      for (const span of runSpans.values()) span.end()
      stepSpans.clear()
      runSpans.clear()
      runContexts.clear()
      pipelines.clear()
    },
  }
}

function addRunEvent(runSpans: ReadonlyMap<string, Span>, runId: string, name: string): void {
  const span = runSpans.get(runId)
  if (!span) return
  span.addEvent(name)
}

function addStepEvent(
  stepSpans: ReadonlyMap<string, Span>,
  runId: string,
  stepId: string,
  name: string,
  attributes?: Attributes,
): void {
  const span = stepSpans.get(stepKey(runId, stepId))
  if (!span) return
  span.addEvent(name, attributes)
}

function cleanupRun(
  runId: string,
  runSpans: Map<string, Span>,
  runContexts: Map<string, Context>,
  pipelines: Map<string, string>,
): void {
  runSpans.delete(runId)
  runContexts.delete(runId)
  pipelines.delete(runId)
}

function stepKey(runId: string, stepId: string): string {
  return `${runId}:${stepId}`
}
