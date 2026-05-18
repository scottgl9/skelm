# Triggers

Triggers fire workflows automatically — on a schedule, when a webhook arrives, when a queue produces a message, when an external source (Telegram, Slack, GitHub) emits an event. The gateway hosts a `TriggerCoordinator` that resolves each fire to a registered workflow, applies an overlap policy, and dispatches the run through the same enforcement (permissions, audit, secrets) used by `skelm run`.

## Trigger kinds

| Kind | When it fires |
|------|---------------|
| `manual` | Only via `coordinator.fire(id)` or `POST /triggers/:id/fire`. |
| `interval` | Every `everyMs` milliseconds. |
| `cron` | On a cron schedule. |
| `at` | Once at a specific timestamp. |
| `immediate` | Once on registration (next tick). |
| `webhook` | When an HTTP request hits `path` (default `POST`). The gateway's webhook router resolves the path to the trigger id. |
| `poll` | Every `everyMs` ticks: a registered source function returns a value; the coordinator fires only when the dedupe key changes. |
| `queue` | When a registered queue driver delivers a message. The coordinator runs the driver's loop; the driver invokes `onMessage(payload?)` per event. |

`webhook`, `poll`, and `queue` all support carrying a per-fire **payload** through to the workflow.

## Overlap policy

Applied when a fire arrives while a previous fire on the same trigger is still in flight:

| Policy | Behavior |
|--------|----------|
| `skip` (default) | New fire is dropped silently. |
| `queue` | New fire enqueues and runs in arrival order. |
| `cancel` | Currently behaves as `skip`; wired to true cancellation when the runner gains the right hook. |

## Payload flow

The fire context carries an optional payload that flows through to the workflow:

```ts
interface FireContext {
  triggerId: string
  workflowId: string
  firedAt: string
  payload?: unknown   // forwarded by queue drivers, webhook adapters, ...
}
```

In the dispatcher:

- If `payload` is set, it is passed as the **pipeline input** (validated against the pipeline's `inputSchema` like any other run input).
- Otherwise the dispatcher passes `{ triggerId, firedAt }` as the input — the right default for `cron` / `interval` / `manual` triggers that have no event data.

This is how a Telegram or Slack message reaches a pipeline: the source emits the message as the `payload`, and the workflow consumes it as `ctx.input`.

## Declaring triggers on a pipeline

Most workflows should declare their triggers inline in the pipeline file. The gateway reads `pipeline.triggers` at startup, resolves each entry against the configured sources, and registers it with the coordinator:

```ts
import { pipeline, agent } from '@skelm/core'

export default pipeline({
  id: 'telegram-bot',
  input: TelegramInputSchema,
  output: TelegramOutputSchema,
  triggers: [{ kind: 'queue', sourceId: 'telegram' }],
  steps: [agent({ id: 'reply', backend: 'pi', /* ... */ })],
  finalize: (ctx) => ({ reply: extractText(ctx) }),
})
```

The `id` and `workflowId` are inferred (workflowId from the workflow registry; id defaults to `<workflowId>#<kind>`). Pipeline-declared triggers are a customer-facing subset of `TriggerSpec` — currently `queue`, `webhook`, `cron`, `interval`. For dynamic registration use the HTTP API or call `gateway.managers.triggers.register()` directly.

## Registering trigger sources in `skelm.config.ts`

A pipeline that declares `{ kind: 'queue', sourceId: 'telegram' }` needs the gateway to know what `telegram` is. Wire it once in the project config:

```ts
import { defineConfig } from '@skelm/core'
import { TelegramIntegration } from '@skelm/integrations'

const telegram = new TelegramIntegration({
  id: 'telegram', name: 'Telegram', enabled: true,
  credentials: { botToken: process.env.TELEGRAM_BOT_TOKEN ?? '' },
})
await telegram.init()

export default defineConfig({
  registries: { workflows: { glob: 'workflows/**/*.pipeline.ts' } },
  triggerSources: [
    { id: 'telegram', driver: telegram.createTriggerSource({ dropPending: true }) },
  ],
})
```

A trigger source is structurally a `QueueDriver`:

```ts
interface QueueDriver {
  start(opts: { config?: Record<string, unknown>; onMessage: (payload?: unknown) => Promise<void> }): Promise<void> | void
  stop(): Promise<void> | void
  onResult?(payload: unknown, output: unknown): Promise<void> | void
}
```

- `start` runs the source's loop. Per event, the source calls `onMessage(payload)`. The payload becomes the pipeline input.
- `stop` is invoked by the gateway on shutdown.
- `onResult` (optional) lets the source react to the run's output. The Telegram source uses this to post `output.reply` back to the originating chat.

You can implement your own driver against any transport (BullMQ, SQS, Redis Streams, NATS, an internal Kafka client) — the gateway only sees the `QueueDriver` contract.

## Webhook triggers

```ts
triggers: [{ kind: 'webhook', path: '/hooks/github', secret: process.env.GH_HOOK_SECRET }]
```

The gateway's HTTP server resolves `POST /hooks/github` to the trigger id and fires it. Webhook payload extraction is currently handled by the route handler — see `packages/gateway/src/http/control-routes.ts`. (Carrying request bodies into `payload` is on the roadmap so webhook-triggered pipelines can take request data as input.)

### Idempotency / dedupe

For sources that retry deliveries with a stable idempotency header (GitHub's `X-GitHub-Delivery`, Slack's `X-Slack-Request-Id`, the generic `Idempotency-Key`), declare the header on the trigger and the gateway short-circuits replays before dispatch:

```ts
triggers: [{
  kind: 'webhook',
  path: '/hooks/github',
  secret: process.env.GH_HOOK_SECRET,
  dedupe: { header: 'X-GitHub-Delivery', ttlMs: 86_400_000 },  // 24 h default
}]
```

The first delivery dispatches as usual. A replay carrying the same header value within `ttlMs` responds 200 with `{ deduped: true }` and emits a `webhook.deduped` audit entry. Deliveries past the TTL — or missing the header entirely — dispatch normally. The store is keyed by `(triggerId, deliveryId)` so two webhook triggers can share an idempotency header without colliding.

## Audit

Every fire emits, through the dispatcher's run lifecycle:

```
trigger.fire   { triggerId, workflowId, firedAt }
trigger.skip   { triggerId, reason: 'overlap' }
trigger.error  { triggerId, message }
```

## End-to-end: Telegram bot

[`examples/telegram-bot/`](https://github.com/scottgl9/skelm/tree/main/examples/telegram-bot) is the canonical worked example: pipeline declares the trigger, config registers the source, `skelm gateway start` runs the loop and dispatches each inbound message into a workflow run with the message as input. The agent's reply is posted back via the source's `onResult`.

## Wiring directly (without pipeline declarations)

For programmatic control or tests:

```ts
const driver = new InMemoryQueueDriver()
gateway.managers.triggers.registerQueueDriver('memq', driver)
gateway.managers.triggers.register({
  kind: 'queue',
  id: 't',
  workflowId: 'workflows/echo.pipeline.ts',
  driver: 'memq',
})

driver.push({ msg: 'hello' })   // fires the workflow with this payload as input
```
