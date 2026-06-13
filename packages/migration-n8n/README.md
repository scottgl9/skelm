# @skelm/migration-n8n

Import an [n8n](https://n8n.io) workflow JSON export into a **reviewable skelm
TypeScript workflow skeleton**.

This is a first-party skelm **workflow package**. Given an n8n export it parses
the graph defensively, maps common node types to skelm step equivalents, and
generates a `pipeline(...)` source string — plus a required-integrations list
and a list of unsupported nodes flagged as `TODO` comments.

> **Generated code is for human review, not auto-activation.** The importer
> never runs, registers, or activates anything. Read the skeleton, fill in the
> `TODO(n8n)` markers, declare permissions, run `pnpm check`, then register it
> through the gateway deliberately.

## Use

```ts
import { migrateN8nWorkflow } from '@skelm/migration-n8n'

const result = migrateN8nWorkflow(exportJsonText) // raw JSON or a parsed object
result.source               // the reviewable pipeline(...) skeleton
result.requiredIntegrations // distinct integration packages the skeleton needs
result.unsupported          // node names with no mapping (flagged TODO in source)
result.fixture              // optional test-fixture stub from sample pinData
```

Malformed input throws a typed `N8nImportError` carrying the offending field
path; nothing partial is returned.

## Node mapping

| n8n node | skelm equivalent | Integration |
| --- | --- | --- |
| HTTP Request | `code` / `invoke` | `@skelm/integration-http` |
| Webhook | `webhook` trigger | — |
| Cron / Schedule / Interval Trigger | `cron` / `interval` trigger | — |
| IF / Switch | `branch` | — |
| Merge | `parallel` | — |
| Set / Function / Code / NoOp | `code` | — |
| Slack / Telegram / GitHub / Microsoft Graph | `invoke` | `@skelm/integrations` |
| OpenAI | `infer` | — |
| AI Agent | `agent` (permissions default-deny) | — |

Any enabled node type without a mapping is **flagged, never dropped** — it
becomes a loud placeholder step plus a `TODO` comment and is listed in
`result.unsupported`. Disabled n8n nodes are omitted from the skeleton so they
stay inert after migration. Use the `integrationOverrides` config to point an
otherwise-unsupported node at a custom integration.

See [Migrating from n8n](https://skelm.dev/reference/migration-n8n) for the full
mapping table and trust posture.

## Running as a workflow

The package ships a `default` workflow (`workflows/import.workflow.ts`) whose
input is the n8n export and optional overrides, and a self-test under
`self-test/`. Install and run it like any workflow package — see
[Workflow Packages](https://skelm.dev/reference/workflow-packages).
