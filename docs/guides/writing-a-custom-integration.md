---
title: Writing a Custom Integration
---

# Writing a Custom Integration

skelm ships built-in integrations for GitHub, Slack, and Telegram via [`@skelm/integrations`](/reference/api/).
When you need a service that isn't covered — Google Calendar, Notion, Linear, Stripe, or anything else — you can author your own using `@skelm/integration-sdk`.

The built-in integrations are themselves authored with this SDK, so the authoring surface is identical for first-party and community packages.

---

## 1. Install the SDK

```bash
pnpm add @skelm/integration-sdk zod
```

---

## 2. Define your integration

Use `defineIntegration()` with a Zod credentials schema. skelm validates credentials automatically at startup — your handlers always receive typed, validated values.

```ts
// src/index.ts
import { defineIntegration } from '@skelm/integration-sdk'
import { z } from 'zod'

export default defineIntegration({
  id: 'google-calendar',
  name: 'Google Calendar',

  capabilities: {
    canTrigger: true,       // can start a pipeline run
    canReceiveWebhooks: true,
    canPoll: true,
    canSendNotifications: false,
  },

  // Zod validates this at init() time — bad credentials fail fast
  credentialsSchema: z.object({
    serviceAccountJson: z.string().min(1, 'Service account JSON is required'),
    calendarId: z.string().min(1, 'Calendar ID is required'),
  }),

  // Optional: live validation after Zod passes
  async validateCredentials(creds) {
    let key: unknown
    try {
      key = JSON.parse(creds.serviceAccountJson)
    } catch {
      throw new Error('serviceAccountJson is not valid JSON')
    }
    if (typeof key !== 'object' || key === null || !('client_email' in key)) {
      throw new Error('serviceAccountJson does not look like a service account key')
    }
  },

  async performHealthCheck(creds) {
    try {
      // Attempt a lightweight API call to verify reachability
      const token = await getAccessToken(creds.serviceAccountJson)
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(creds.calendarId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      return res.ok
    } catch {
      return false
    }
  },

  // Convert an inbound webhook payload to a pipeline RunInput
  async eventToRunInput(event, creds) {
    const e = event as { kind?: string; summary?: string; id?: string }
    if (e.kind !== 'calendar#event') return null
    return {
      trigger: {
        type: 'google-calendar-event',
        calendarId: creds.calendarId,
        eventId: e.id,
        summary: e.summary,
      },
    }
  },
})

// Helper (implement with your preferred Google auth library)
async function getAccessToken(_serviceAccountJson: string): Promise<string> {
  // e.g. use google-auth-library
  throw new Error('Not implemented')
}
```

---

## 3. Package it for reuse

Structure your package like any other skelm integration:

```
skelm-integration-google-calendar/
├── src/
│   └── index.ts          ← default export is your defineIntegration() result
├── package.json
├── tsconfig.json
└── README.md
```

**`package.json`** — the key requirement is that the default export resolves correctly:

```json
{
  "name": "skelm-integration-google-calendar",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@skelm/integration-sdk": "^0.3.0",
    "zod": "^4.0.0"
  }
}
```

> **Naming convention:** Use `skelm-integration-<name>` for published packages. This makes them discoverable and signals their purpose.

---

## 4. Register in skelm.config.ts

```ts
// skelm.config.ts
import { defineConfig } from '@skelm/core'

export default defineConfig({
  // skelm loads the package, detects the Integration default export,
  // and wires it into the plugin registry automatically.
  plugins: ['skelm-integration-google-calendar'],

  secrets: {
    googleServiceAccountJson: { env: 'GOOGLE_SERVICE_ACCOUNT_JSON' },
    googleCalendarId: { env: 'GOOGLE_CALENDAR_ID' },
  },
})
```

Secrets from `config.secrets` are resolved at startup and injected into `config.credentials` — your integration never handles raw env var references.

See the [Secrets guide](/guides/secrets) for more on secret resolution.

---

## 5. Manual registration (without the plugin system)

If you prefer direct control, bypass the `plugins` array and register directly with an `IntegrationRegistry`:

```ts
import { IntegrationRegistry } from '@skelm/integrations'
import GoogleCalendarIntegration from 'skelm-integration-google-calendar'

const registry = new IntegrationRegistry()

await registry.register(
  new GoogleCalendarIntegration({
    id: 'google-calendar',
    name: 'Google Calendar',
    enabled: true,
    credentials: {
      serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON!,
      calendarId: process.env.GOOGLE_CALENDAR_ID!,
    },
  }),
)
```

---

## 6. Webhooks

If your integration supports inbound webhooks (`canReceiveWebhooks: true`), implement `setupWebhook` and `cleanupWebhook`:

```ts
defineIntegration({
  // ...
  capabilities: { canReceiveWebhooks: true, /* ... */ },

  async setupWebhook(creds, config, webhook) {
    // Register webhook.path with the provider
    // webhook.secret is available for signature verification
    await registerWebhookWithProvider({
      url: `https://your-gateway-host${webhook.path}`,
      secret: webhook.secret,
      events: webhook.events,
    })
  },

  async cleanupWebhook(creds, config, webhook) {
    await deregisterWebhookWithProvider({ path: webhook.path })
  },
})
```

Configure the webhook path and secret in `skelm.config.ts`:

```ts
defineConfig({
  plugins: ['skelm-integration-google-calendar'],
  integrations: {
    'google-calendar': {
      webhook: {
        path: '/webhooks/google-calendar',
        secret: { secret: 'googleWebhookSecret' },
        events: ['calendar.event.created', 'calendar.event.updated'],
      },
    },
  },
})
```

---

## 7. Extending IntegrationBase directly

`defineIntegration()` covers most use cases, but if you need full control — custom constructor arguments, additional public methods, complex internal state — extend `IntegrationBase` directly. The built-in `TelegramIntegration` is a good reference: it injects a `fetch` implementation for testability and exposes methods like `sendMessage()`, `getMe()`, and `createTriggerSource()` that go beyond the standard `Integration` interface.

Note that `GitHubIntegration` and `SlackIntegration` are authored with `defineIntegration()`, so they're also good reference implementations for the typical case:

```ts
import { IntegrationBase } from '@skelm/integration-sdk'
import type { IntegrationCapabilities, IntegrationConfig } from '@skelm/integration-sdk'

export class GoogleCalendarIntegration extends IntegrationBase {
  override readonly id = 'google-calendar' as const
  override readonly name = 'Google Calendar'
  override readonly capabilities: IntegrationCapabilities = {
    canTrigger: true,
    canReceiveWebhooks: true,
    canPoll: true,
    canSendNotifications: false,
  }

  private accessToken: string | null = null

  protected override async validateCredentials(): Promise<void> {
    const { serviceAccountJson } = this.config.credentials
    if (!serviceAccountJson) throw new Error('serviceAccountJson is required')
    this.accessToken = await getAccessToken(String(serviceAccountJson))
  }

  protected override async performHealthCheck(): Promise<boolean> {
    return this.accessToken !== null
  }

  // Add any custom public methods here
  async listUpcomingEvents(maxResults = 10): Promise<unknown[]> {
    // implementation
    return []
  }
}
```

---

## API reference

See the [`@skelm/integration-sdk` README](https://github.com/scottgl9/skelm/tree/main/packages/integration-sdk#api-reference) for the full `defineIntegration()` option reference.
