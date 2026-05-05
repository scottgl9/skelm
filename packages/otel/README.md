# @skelm/otel

> OpenTelemetry tracing for [skelm](https://github.com/scottgl9/skelm) event streams.

[![npm](https://img.shields.io/npm/v/@skelm/otel)](https://www.npmjs.com/package/@skelm/otel)

Part of [skelm](https://github.com/scottgl9/skelm).

Translate skelm `RunEvent`s into OpenTelemetry spans: one parent span per run, child spans per step, with status, attributes, and exception recording. Use any OTel SDK (Jaeger, Tempo, Honeycomb, Datadog, etc.) — this package only emits, it does not configure exporters.

## Install

```bash
npm install @skelm/otel @opentelemetry/api
```

You also need an OpenTelemetry SDK package (e.g. `@opentelemetry/sdk-node`) to actually export the spans somewhere.

## Quick Start

```ts
import { trace } from '@opentelemetry/api'
import { runPipeline, EventBus } from 'skelm'
import { attachOpenTelemetry } from '@skelm/otel'

// You wire an OTel SDK / exporter elsewhere, as you would for any service.

const events = new EventBus()
const attachment = attachOpenTelemetry(events, { tracerName: 'my-app' })

await runPipeline(myWorkflow, input, { events })

attachment.dispose()
```

Pass an explicit tracer if you want a non-default one:

```ts
attachOpenTelemetry(events, { tracer: trace.getTracer('billing-service') })
```

## What gets emitted

| Span                         | Notes                                                                |
| ---------------------------- | -------------------------------------------------------------------- |
| `skelm.run`                  | Parent span per run; status reflects the run's terminal status       |
| `skelm.step`                 | Child span per step; carries `step.id`, `step.kind`, retry attempts  |
| Exceptions                   | Recorded via `span.recordException` for failed steps and runs        |

The package is intentionally small — it adds no global hooks, no exporters, and no telemetry of its own. You decide what your stack does with the spans.

## Stability

`0.x` — APIs may change between minor versions until v1.

## License

[MIT](LICENSE)
