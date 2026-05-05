# @skelm/scheduler

> Long-running trigger management for [skelm](https://github.com/scottgl9/skelm) pipelines — cron, interval, webhook, poll, and queue triggers with deduplication and overlap policies.

[![npm](https://img.shields.io/npm/v/@skelm/scheduler)](https://www.npmjs.com/package/@skelm/scheduler)

Part of [skelm](https://github.com/scottgl9/skelm).

The scheduler turns "run this once" into "run this whenever". It is the same code path used by `@skelm/gateway` to fire scheduled work, but exposed as a small standalone library so embedders can drive triggers without taking the full gateway dependency.

## Install

```bash
npm install @skelm/scheduler
```

## Quick Start

```ts
import { Scheduler, createCronTrigger, createWebhookTrigger } from '@skelm/scheduler'

const scheduler = new Scheduler({ maxConcurrentRuns: 8 })

scheduler.register(
  createCronTrigger({ id: 'nightly-digest', schedule: '0 9 * * 1-5' }),
  async (ctx) => {
    // run a pipeline, post results, etc.
  },
)

scheduler.register(
  createWebhookTrigger({ id: 'issue-events', path: '/webhooks/issue-events' }),
  async (ctx) => { /* ... */ },
)

await scheduler.start()
```

## Trigger types

| Builder                  | When it fires                                                              |
| ------------------------ | -------------------------------------------------------------------------- |
| `createCronTrigger`      | On a cron schedule (`'0 9 * * 1-5'`)                                       |
| `createIntervalTrigger`  | Every N milliseconds                                                       |
| `createWebhookTrigger`   | When the gateway receives a request at the trigger's path                  |
| `createPollTrigger`      | When a polling function returns new items                                  |
| `createQueueTrigger`     | When a message arrives on a connected queue (in-memory or external broker) |

## Policies

- **Deduplication** — provide a `dedupeKey(ctx)`; the scheduler suppresses duplicate firings within a configurable window.
- **Overlap** — choose what happens when a trigger fires while a previous run is still in flight: `skip`, `queue`, or `parallel`.
- **Retry / backoff** — handled at the pipeline runner layer; the scheduler treats every firing as a fresh request.

## Public exports

```ts
export { Scheduler } from './scheduler.js'
export {
  createCronTrigger, createIntervalTrigger,
  createWebhookTrigger, createPollTrigger, createQueueTrigger,
} from './builders.js'
export type {
  SchedulerConfig, Trigger, TriggerRegistration, TriggerContext, TriggerType,
  DedupePolicy, OverlapPolicy, TriggerBase,
  CronTrigger, IntervalTrigger, WebhookTrigger, PollTrigger, QueueTrigger,
  TriggerOptions,
} from './types.js'
```

## Stability

`0.x` — APIs may change between minor versions until v1.

## License

[MIT](LICENSE)
