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

## GitHub REST helpers

For PR-review and webhook-management workflows the package also exports
standalone REST helpers that take a plain `GitHubAuth` and don't require an
integration instance. They are the recommended path for PR-review pipelines
that previously shelled out to the `gh` CLI.

```ts
import {
  postPullRequestReview,
  postIssueComment,
  registerWebhook,
  deleteWebhook,
  getAuthenticatedUser,
  GitHubApiError,
} from '@skelm/integrations'

const auth = { token: process.env.GITHUB_TOKEN! }

// Post a review against a PR.
await postPullRequestReview({
  auth,
  owner: 'octo',
  repo: 'demo',
  number: 42,
  event: 'REQUEST_CHANGES',      // 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  body: 'See inline comments.',
  comments: [{ path: 'src/x.ts', line: 12, body: 'nit: rename' }],
})

// Drop a follow-up issue comment.
await postIssueComment({ auth, owner: 'octo', repo: 'demo', number: 42, body: 'pong' })

// Register a webhook (returns the hook id for later cleanup).
const hook = await registerWebhook({
  auth, owner: 'octo', repo: 'demo',
  url: 'https://gateway.example/hooks/gh',
  secret: process.env.GITHUB_WEBHOOK_SECRET,
  events: ['pull_request', 'issue_comment', 'pull_request_review'],
})
await deleteWebhook({ auth, owner: 'octo', repo: 'demo', hookId: hook.id })
```

Failed calls raise `GitHubApiError` with `status`, `method`, `path`, and the
parsed response body. The helpers warn to stderr when GitHub's
`X-RateLimit-Remaining` drops below 10 % of the quota so operators see
throttling coming before it bites.

The `GitHubIntegration` class wires the same helpers through
`performHealthCheck` (`GET /user`), `setupWebhook` (`POST /hooks`),
`cleanupWebhook` (`DELETE /hooks/:id`), and `sendNotification` (routes to
`POST /issues/:n/comments` by default, or to `POST /pulls/:n/reviews` when
`options.kind === 'pr-review'`).

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
