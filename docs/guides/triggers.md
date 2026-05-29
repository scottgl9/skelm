# Triggers

Triggers fire workflows automatically — on a schedule, when a webhook arrives, when a queue produces a message, when an external source (Telegram, Slack, GitHub) emits an event. The gateway hosts a `TriggerCoordinator` that resolves each fire to a registered workflow, applies an overlap policy, and dispatches the run through the same enforcement (permissions, audit, secrets) used by `skelm run`.

## Trigger kinds

| Kind | When it fires |
|------|---------------|
| `manual` | Only via `coordinator.fire(id)` or `POST /triggers/:id/fire`. |
| `interval` | Every `everyMs` milliseconds — or every `every` (e.g. `"15m"`, `"2h"`). |
| `cron` | On a cron schedule. Optional `tz` projects matches into a named IANA timezone. |
| `at` | Once at a specific timestamp. |
| `immediate` | Once on registration (next tick). |
| `webhook` | When an HTTP request hits `path` (default `POST`). Optional `provider: 'slack' \| 'ms-graph'` swaps in provider-specific signature verification and challenge handling. |
| `file-watch` | When a filesystem path changes (create / update / delete), debounced. |
| `event-source` | When an external event source (WebSocket, SSE, RSS, or a custom callback) produces a message. |
| `poll` | Every `everyMs` ticks: a registered source function returns a value; the coordinator fires only when the dedupe key changes. |
| `queue` | When a registered queue driver delivers a message. The coordinator runs the driver's loop; the driver invokes `onMessage(payload?)` per event. |

`webhook`, `poll`, `queue`, `file-watch`, and `event-source` all support carrying a per-fire **payload** through to the workflow.

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
  registries: { workflows: { glob: 'workflows/**/*.pipeline.mts' } },
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

## GitHub PR trigger

`@skelm/integrations` ships a `github-pr` helper that compiles a declarative PR-aware trigger spec down to a `webhook` trigger (with `X-GitHub-Delivery` dedupe enabled) plus a normalized payload mapper:

```ts
import { pipeline } from 'skelm'
import { code, agent } from '@skelm/core'

export default pipeline({
  id: 'review-pr',
  triggers: [{
    kind: 'github-pr',
    path: '/hooks/gh-pr',
    secret: process.env.GITHUB_WEBHOOK_SECRET,
    events: ['opened', 'synchronize', 'review_requested', 'commented'],
    filter: { dropBotAuthors: true, repos: ['octo/demo'] },
  }],
  steps: [/* … */],
})
```

At gateway startup, bind the declared spec with `registerGitHubPrTrigger()` so the coordinator owns the webhook route and the helper returns a `normalize()` you apply to each delivery's `{ body, headers }` envelope:

```ts
import { registerGitHubPrTrigger } from '@skelm/integrations'

const { normalize } = registerGitHubPrTrigger(gateway.managers.triggers, {
  id: 'gh-pr',
  workflowId: 'review-pr',
  path: '/hooks/gh-pr',
  events: ['opened', 'synchronize', 'review_requested', 'commented'],
  filter: { dropBotAuthors: true, repos: ['octo/demo'] },
})

// In your run dispatcher: normalize(ctx.payload) → { pr, kind, authorIsBot, … }
// then either dispatch the run with the normalized payload as input, or skip
// silently when normalize() returns null (event filtered out).
```

The normalized `GitHubPrPayload`:

```ts
{
  kind: 'opened' | 'synchronize' | 'reopened' | 'closed' | 'review_requested' | 'commented' | 'submitted',
  pr: { owner, repo, number, headSha, baseSha, author, labels },
  authorIsBot: boolean,
  githubEvent: string,    // raw GitHub event name
  action: string,         // raw GitHub action
  raw: unknown,           // original webhook payload, for fields not yet normalized
}
```

This combination — typed events, payload normalization, bot/repo filtering, and 24 h dedupe on `X-GitHub-Delivery` — absorbs the webhook + cron + dedupe + bot-filter boilerplate every PR-aware agent would otherwise rewrite.

## Cron timezone

By default `parseCron` evaluates fields in the gateway's local time. To pin a schedule to a specific zone — useful for "9 AM in `America/New_York`" regardless of DST or where the gateway runs — pass an IANA timezone:

```ts
triggers: [{ kind: 'cron', cron: '0 9 * * 1-5', tz: 'America/New_York' }]
```

The trigger fires at 09:00 New York time year-round; the gateway resolves matches via `Intl.DateTimeFormat`. Invalid timezone names are rejected at registration with `lastError`.

## Interval duration strings

The interval kind accepts a human-readable `every` in addition to the raw `everyMs`. Suffixes: `ms`, `s`, `m`, `h`, `d`.

```ts
triggers: [{ kind: 'interval', every: '15m' }]            // every 15 minutes
triggers: [{ kind: 'interval', every: '1h' }]             // every hour
triggers: [{ kind: 'interval', everyMs: 250, every: '1h' }]  // everyMs wins
```

Normalization happens at pipeline construction (`parseDuration` from `@skelm/core`). Unparseable strings throw immediately so a typo doesn't ship as a never-firing schedule.

## File-watch trigger

```ts
triggers: [{
  kind: 'file-watch',
  path: './data/incoming',
  events: ['create', 'update'],   // default: all three
  debounceMs: 100,                // default
}]
```

The gateway runs `fs.watch(path, { recursive: true })`. Rapid changes to the same path inside `debounceMs` are coalesced into a single fire. Rename events are mapped to `create` or `delete` based on whether the path exists when the event flushes.

The payload delivered to the pipeline:

```ts
{ path: string, event: 'create' | 'update' | 'delete', watchedPath: string, firedAt: string }
```

## Event-source triggers

Subscribe to an external stream and fire the pipeline per message. Generic protocols only — provider-specific sockets (Slack socket mode, Discord gateway) belong inside their `@skelm/integrations` integration.

```ts
// WebSocket
triggers: [{
  kind: 'event-source',
  source: 'websocket',
  options: { url: 'wss://example.com/stream', reconnect: true },
}]

// Server-Sent Events
triggers: [{
  kind: 'event-source',
  source: 'sse',
  options: { url: 'https://example.com/events' },
}]

// RSS / Atom poll
triggers: [{
  kind: 'event-source',
  source: 'rss',
  options: { feedUrl: 'https://example.com/feed.xml', pollIntervalMs: 300_000 },
}]

// Custom — caller controls the lifecycle
triggers: [{
  kind: 'event-source',
  source: 'custom',
  options: {
    start: (fire, signal) => {
      const handle = subscribe((msg) => fire(msg))
      signal.addEventListener('abort', () => handle.close())
    },
  },
}]
```

Reconnect uses exponential backoff (`reconnectDelayMs` base, capped at 60s). RSS dedupes by `guid`/`id`/`link` so the same item never fires twice. An optional `filter: Record<string, unknown>` does shallow equality matching against the payload — useful for `{ source: 'websocket' }` streams that mix event types.

## Webhook providers (Slack / MS Graph)

Webhooks signed by a specific vendor need that vendor's signature scheme — declare `provider` and the gateway routes through `@skelm/integrations`:

```ts
import { pipeline } from 'skelm'

export default pipeline({
  id: 'slack-events',
  triggers: [{
    kind: 'webhook',
    path: '/hooks/slack',
    provider: 'slack',
    secret: process.env.SLACK_SIGNING_SECRET,    // signing secret, not bot token
  }],
  steps: [/* … */],
})
```

What the gateway does for `provider: 'slack'`:

- Reads the raw body before any JSON parse.
- Verifies `X-Slack-Signature` over `v0:<timestamp>:<rawBody>` with HMAC-SHA256, constant-time compared.
- Rejects requests whose `X-Slack-Request-Timestamp` is older than 5 minutes (replay window).
- Short-circuits the one-shot `url_verification` handshake — the gateway echoes the `challenge` without firing the pipeline.

For `provider: 'ms-graph'`:

```ts
triggers: [{
  kind: 'webhook',
  path: '/hooks/graph',
  provider: 'ms-graph',
}]
```

The coordinator registers GET + POST for the path. A GET carrying `?validationToken=…` is answered in plain text within the same request (no pipeline fire). POST deliveries carry the standard Graph envelope `{ value: [{ clientState, changeType, resource, ... }] }`. Use `verifyMsGraphClientState()` from `@skelm/integrations` in your first step to reject spoofed callers; `MsGraphIntegration` does this automatically when wired in as the source.

## Audit

Every fire emits, through the dispatcher's run lifecycle:

```
trigger.fire   { triggerId, workflowId, firedAt }
trigger.skip   { triggerId, reason: 'overlap' }
trigger.error  { triggerId, message }
```

## End-to-end: Telegram bot

[`examples/telegram-bot/`](https://github.com/scottgl9/skelm/tree/main/examples/telegram-bot) is the canonical worked example: pipeline declares the trigger, config registers the source, `skelm gateway start` runs the loop and dispatches each inbound message into a workflow run with the message as input. The agent's reply is posted back via the source's `onResult`.

### Who-can-talk allowlist

`telegram.createTriggerSource({ allowedChatIds, allowedUsers })` drops inbound updates from any chat / sender not on the allowlist *before* they fire a workflow. Each configured filter is a gate (both must pass when both are set). This is **strongly recommended** whenever the target is a privileged or [unrestricted](/concepts/permissions#the-unrestricted-bypass-freewheeling-agents) agent: an open Telegram channel that drives such an agent lets anyone who finds the bot act as it.

```ts
telegram.createTriggerSource({
  dropPending: true,
  allowedChatIds: ['123456789'], // only this chat may talk to the bot
})
```

## Triggers that drive a persistent workflow

A trigger's `workflowId` can resolve to a [persistent workflow](/concepts/persistent-workflows) instead of a plain pipeline. The declaration is identical — a persistent workflow exposes the same `triggers` array — but the gateway routes the fire through any preamble steps and then to a single durable conversational *turn* rather than a fresh stateless run:

```ts
export default persistentWorkflow({
  id: 'support-bot',
  triggers: [{ kind: 'queue', sourceId: 'telegram' }],
  agent: {
    backend: 'pi',
    sessionKey: (msg) => msg.chatId,
  },
})
```

A `queue` trigger turns each inbound message into a turn (with the reply posted via `onResult`); a `cron`/`interval` trigger drives proactive turns. The conversation for each `sessionKey` is durable across fires and restarts.

## Wiring directly (without pipeline declarations)

For programmatic control or tests:

```ts
const driver = new InMemoryQueueDriver()
gateway.managers.triggers.registerQueueDriver('memq', driver)
gateway.managers.triggers.register({
  kind: 'queue',
  id: 't',
  workflowId: 'workflows/echo.pipeline.mts',
  driver: 'memq',
})

driver.push({ msg: 'hello' })   // fires the workflow with this payload as input
```
