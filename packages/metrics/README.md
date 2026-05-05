# @skelm/metrics

> Prometheus-format metrics for [skelm](https://github.com/scottgl9/skelm) event streams.

[![npm](https://img.shields.io/npm/v/@skelm/metrics)](https://www.npmjs.com/package/@skelm/metrics)

Part of [skelm](https://github.com/scottgl9/skelm).

Subscribe a `MetricsCollector` to any skelm `EventBus` and expose the resulting counters / gauges / histograms in Prometheus text format. In-process, zero managed-service dependency, zero telemetry.

## Install

```bash
npm install @skelm/metrics
```

## Quick Start

```ts
import { runPipeline, EventBus } from 'skelm'
import { MetricsCollector } from '@skelm/metrics'

const events = new EventBus()
const metrics = new MetricsCollector()
const detach = metrics.attach(events)

await runPipeline(myWorkflow, input, { events })

console.log(metrics.render())  // Prometheus exposition format
detach()
```

Wire `render()` into your HTTP server to expose `/metrics`:

```ts
import { createServer } from 'http'

createServer((req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('content-type', 'text/plain; version=0.0.4')
    res.end(metrics.render())
  }
}).listen(9090)
```

## What is collected

| Metric                            | Type      | Labels                |
| --------------------------------- | --------- | --------------------- |
| `skelm_runs_started_total`        | counter   | —                     |
| `skelm_runs_total`                | counter   | `status`              |
| `skelm_runs_in_flight`            | gauge     | —                     |
| `skelm_steps_total`               | counter   | `kind`, `status`      |
| `skelm_step_duration_ms`          | histogram | —                     |
| `skelm_permission_denials_total`  | counter   | —                     |
| `skelm_approvals_pending`         | gauge     | —                     |
| `skelm_trigger_fires_total`       | counter   | `trigger`             |

Histogram buckets target agentic workflows, where step latency ranges from ~10 ms (deterministic code) to many minutes (LLM + tool loops): `10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000` ms.

## Stability

`0.x` — APIs may change between minor versions until v1.

## License

[MIT](LICENSE)
