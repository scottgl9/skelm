# OpenTelemetry traces

`@skelm/otel` ships an `attachOpenTelemetry(events)` adapter that maps
skelm's run events onto OTel spans (one span per run, nested spans per
step, exception recording on errors). It does **not** ship an exporter —
that's deliberate. Pick the OTLP exporter that matches your collector
and wire it once at process startup.

## Minimal wiring (OTLP over HTTP)

```ts
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { attachOpenTelemetry } from '@skelm/otel'
import { Runner } from '@skelm/core'

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }),
  serviceName: 'skelm-app',
})
sdk.start()

const runner = new Runner({ /* ... */ })
attachOpenTelemetry(runner.events) // subscribe before starting runs

// On shutdown:
process.on('SIGTERM', async () => {
  await sdk.shutdown()
  process.exit(0)
})
```

That's the entire integration. The adapter creates a parent span for each
`run.started`, child spans for each `step.start`, and closes them on
matching `step.completed` / `run.completed` events. Failures call
`span.recordException(error)` and set the status code.

## Gateway-hosted

The gateway constructs runners internally. Subscribe its event bus the
same way:

```ts
import { Gateway } from '@skelm/gateway'
import { attachOpenTelemetry } from '@skelm/otel'

const gw = new Gateway({ /* ... */ })
await gw.start()
gw.attachMetricsBus = (bus) => attachOpenTelemetry(bus)
```

(`attachMetricsBus` is the same hook the Prometheus collector uses;
attaching OTel and metrics together is fine — they both subscribe.)

## Collector configuration

Any OTLP-compatible collector accepts the traffic — Tempo, Jaeger,
Grafana Cloud, Honeycomb, Datadog. The skelm side does not care which.
Use whatever your existing infrastructure already runs.

## Why no exporter ships in `@skelm/otel`

Each exporter pulls in transport-specific deps (`@opentelemetry/exporter-trace-otlp-grpc`,
`-http`, vendor-specific shippers). Bundling one would force every skelm
install to pay for it; bundling all of them would make the package
heavyweight. Keeping the adapter exporter-agnostic is the same call
`@opentelemetry/api` made — record spans here, ship them however the
deployment wants.
