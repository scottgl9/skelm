# @skelm/integration-sdk

The authoring SDK for building custom skelm integrations.

Install this package when you want to **create** your own integration.  
Install [`@skelm/integrations`](../integrations) when you want to **use** the built-in ones (GitHub, Slack, Telegram, etc.) — the built-ins are themselves authored with this SDK.

---

## Installation

```bash
pnpm add @skelm/integration-sdk zod
```

---

## Quick start

Define your integration with `defineIntegration()`, providing a Zod schema for credentials validation and handler functions for each capability you support:

```ts
// packages/skelm-integration-notion/src/index.ts
import { defineIntegration } from '@skelm/integration-sdk'
import { z } from 'zod'

export const NotionIntegration = defineIntegration({
  id: 'notion',
  name: 'Notion',

  capabilities: {
    canTrigger: false,
    canReceiveWebhooks: false,
    canPoll: true,
    canSendNotifications: true,
  },

  // Zod schema — validated automatically at init() time
  credentialsSchema: z.object({
    apiKey: z.string().min(1, 'Notion API key is required'),
    databaseId: z.string().min(1, 'Notion database ID is required'),
  }),

  // Optional: live validation (called after Zod passes)
  async validateCredentials(creds) {
    const res = await fetch('https://api.notion.com/v1/users/me', {
      headers: { Authorization: `Bearer ${creds.apiKey}`, 'Notion-Version': '2022-06-28' },
    })
    if (!res.ok) throw new Error(`Notion token rejected: ${res.status}`)
  },

  async performHealthCheck(creds) {
    try {
      const res = await fetch('https://api.notion.com/v1/users/me', {
        headers: { Authorization: `Bearer ${creds.apiKey}`, 'Notion-Version': '2022-06-28' },
      })
      return res.ok
    } catch {
      return false
    }
  },

  async sendNotification(message, opts, creds) {
    const parentId = (opts?.pageId as string | undefined) ?? creds.databaseId
    await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        parent: { database_id: parentId },
        properties: {
          Name: { title: [{ text: { content: message } }] },
        },
      }),
    })
  },
})
```

---

## Registering in skelm.config.ts

```ts
// skelm.config.ts
import { defineConfig } from '@skelm/core'

export default defineConfig({
  plugins: ['skelm-integration-notion'],

  secrets: {
    notionApiKey: { env: 'NOTION_API_KEY' },
    notionDatabaseId: { env: 'NOTION_DATABASE_ID' },
  },
})
```

The gateway's `PluginLoader` detects the `Integration` default export and wraps it automatically. Credentials from `config.secrets` are resolved and injected at startup — your integration never sees raw env var references.

---

## Manual registration (without the plugin system)

If you prefer direct control:

```ts
import { IntegrationRegistry } from '@skelm/integrations'
import { NotionIntegration } from 'skelm-integration-notion'

const registry = new IntegrationRegistry()

await registry.register(
  new NotionIntegration({
    id: 'notion',
    name: 'Notion',
    enabled: true,
    credentials: {
      apiKey: process.env.NOTION_API_KEY!,
      databaseId: process.env.NOTION_DATABASE_ID!,
    },
  }),
)
```

---

## Extending IntegrationBase directly

For more complex cases where `defineIntegration()` isn't flexible enough, extend `IntegrationBase` directly:

```ts
import { IntegrationBase } from '@skelm/integration-sdk'
import type { IntegrationCapabilities, IntegrationConfig } from '@skelm/integration-sdk'

export class GoogleCalendarIntegration extends IntegrationBase {
  readonly id = 'google-calendar' as const
  readonly name = 'Google Calendar'
  readonly capabilities: IntegrationCapabilities = {
    canTrigger: true,
    canReceiveWebhooks: true,
    canPoll: true,
    canSendNotifications: false,
  }

  protected async validateCredentials(): Promise<void> {
    const { serviceAccountJson } = this.config.credentials
    if (!serviceAccountJson) throw new Error('serviceAccountJson is required')
    JSON.parse(String(serviceAccountJson)) // throws on invalid JSON
  }

  protected async performHealthCheck(): Promise<boolean> {
    return true
  }
}
```

---

## API reference

### `defineIntegration(options)`

| Option | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | ✅ | Unique identifier (e.g. `'notion'`) |
| `name` | `string` | ✅ | Display name |
| `capabilities` | `IntegrationCapabilities` | ✅ | Declare what the integration can do |
| `credentialsSchema` | `ZodType` | ✅ | Zod schema for credentials validation |
| `performHealthCheck` | `(creds, config) => Promise<boolean>` | ✅ | Health probe |
| `validateCredentials` | `(creds, config) => Promise<void>` | — | Live validation (after Zod) |
| `setupWebhook` | `(creds, config, webhook) => Promise<void>` | — | Called at init when webhook is configured |
| `cleanupWebhook` | `(creds, config, webhook) => Promise<void>` | — | Called at shutdown |
| `eventToRunInput` | `(event, creds, config) => Promise<RunInput \| null>` | — | Convert inbound event to pipeline input |
| `sendNotification` | `(message, opts, creds, config) => Promise<void>` | — | Outbound notification |

### `createIntegrationPlugin(integration)`

Wraps an `Integration` instance as a `WorkflowPlugin` compatible with `PluginRegistry`. Used internally by `PluginLoader`.

### `IntegrationBase`

Abstract base class. Extend this when `defineIntegration()` is too limiting.

---

## Naming convention for published packages

Community integration packages should follow the `skelm-integration-<name>` convention:

- `skelm-integration-notion`
- `skelm-integration-google-calendar`
- `skelm-integration-linear`

This makes them discoverable and clearly signals their purpose.
