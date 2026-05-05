# @skelm/integrations

> Typed third-party integrations for [skelm](https://github.com/scottgl9/skelm) pipelines — GitHub, Slack, Jira, IMAP, Telegram, with a uniform `Integration` interface and trigger types.

[![npm](https://img.shields.io/npm/v/@skelm/integrations)](https://www.npmjs.com/package/@skelm/integrations)

Part of [skelm](https://github.com/scottgl9/skelm).

This package contains the `IntegrationBase` class, the `IntegrationRegistry`, and a curated set of connector implementations + trigger types. New connectors land here as the framework matures.

## Install

```bash
npm install @skelm/integrations
```

## Quick Start

```ts
import { GitHubIntegration, IntegrationRegistry } from '@skelm/integrations'

const registry = new IntegrationRegistry()
registry.register(new GitHubIntegration({
  auth: { type: 'token', token: process.env.GITHUB_TOKEN! },
}))

const gh = registry.get<GitHubIntegration>('github')
const issue = await gh.getIssue({ owner: 'scottgl9', repo: 'skelm', number: 42 })
```

Drive integrations from a workflow via a `code()` step:

```ts
import { code, pipeline } from 'skelm'
import { GitHubIntegration } from '@skelm/integrations'

const gh = new GitHubIntegration({ auth: { type: 'token', token: process.env.GITHUB_TOKEN! } })

export default pipeline({
  id: 'label-issue',
  steps: [
    code({
      id: 'add-label',
      run: async (ctx) => {
        await gh.addLabel({ owner: 'scottgl9', repo: 'skelm', number: ctx.input.number, label: 'triaged' })
      },
    }),
  ],
})
```

## Built-in connectors

| Connector       | Status     | Trigger types                                              |
| --------------- | ---------- | ---------------------------------------------------------- |
| **GitHub**      | Implemented | `GitHubIssueTrigger`, generic webhook events              |
| **Slack**       | Implemented | `SlackWebhookEvent`                                        |
| **Jira**        | Types only  | `JiraIssueTrigger`                                         |
| **IMAP / Email**| Types only  | `EmailTrigger`                                             |
| **Telegram**    | Types only  | `TelegramMessageTrigger`, `TelegramWebhookEvent`           |

"Types only" entries ship the trigger / config types so consumers can author handlers, but the runtime adapter is not yet shipped — implement against `IntegrationBase` and contribute it back.

## Public exports

```ts
export { IntegrationBase } from './base.js'
export { GitHubIntegration } from './github.js'
export { SlackIntegration } from './slack.js'
export { IntegrationRegistry } from './registry.js'

export type {
  IntegrationConfig, WebhookConfig, RateLimitConfig,
  IntegrationCapabilities, Integration,
  GitHubConfig, GitHubWebhookEvent, GitHubIssueTrigger,
  SlackConfig, SlackWebhookEvent,
  JiraConfig, JiraIssueTrigger,
  IMAPConfig, EmailTrigger,
  TelegramConfig, TelegramWebhookEvent, TelegramMessageTrigger,
} from './types.js'
```

## Writing a custom integration

```ts
import { IntegrationBase } from '@skelm/integrations'

export class MyServiceIntegration extends IntegrationBase {
  readonly id = 'myservice'
  readonly capabilities = { webhooks: true, polling: false }

  constructor(private readonly config: { auth: { apiKey: string } }) { super() }

  async ping() { /* health check */ }

  async doSomething(input: { foo: string }) {
    // call your API, validate inputs, return typed result
  }
}
```

## Stability

`0.x` — APIs may change between minor versions until v1.

## License

[MIT](LICENSE)
