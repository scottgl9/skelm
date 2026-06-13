# Migrating from n8n

`@skelm/migration-n8n` is a first-party workflow package that imports an
**n8n workflow JSON export** into a **reviewable skelm TypeScript workflow
skeleton**. It does not run, register, or activate anything — the output is a
`pipeline(...)` source string for a human to inspect, complete, and register
deliberately.

> **Generated code is for review.** Every skeleton is annotated with `TODO(n8n)`
> markers, ships placeholder step bodies, and leaves agent/permission decisions
> to you. Nothing the importer emits is auto-activated. Treat the output the way
> you would treat a scaffold: read it, fill in the TODOs, run `pnpm check`, then
> register it through the gateway.

## What it does

Given an export, the importer:

1. **Parses defensively at the boundary.** Unknown fields are tolerated; the
   invariants the mapper depends on (an object with a non-empty `nodes` array,
   each node named and typed) are enforced strictly. A malformed export throws a
   typed `N8nImportError` carrying the offending field path — nothing partial is
   returned.
2. **Maps each enabled node** to its skelm step equivalent (see the table
   below). Disabled n8n nodes are omitted so they stay inert after migration.
3. **Generates a TypeScript skeleton** — a `pipeline(...)` module reflecting the
   mapped steps and triggers, a required-integrations list, and every
   unsupported node flagged as a `TODO` comment.
4. **Optionally emits a test-fixture stub** from sample execution data
   (`pinData`) when the export carried any.

## Node mapping

Matching is by the node-type suffix after the vendor prefix
(`n8n-nodes-base.`), compared case-insensitively, so community nodes that share
a suffix map the same way.

| n8n node | skelm equivalent | Integration |
| --- | --- | --- |
| HTTP Request | `code` step (fetch) / `invoke` | `@skelm/integration-http` |
| Webhook | `webhook` trigger | — |
| Cron | `cron` trigger | — |
| Schedule Trigger | `interval`/`cron` trigger | — |
| Interval Trigger | `interval` trigger | — |
| IF / Switch | `branch` | — |
| Merge | `parallel` (merged in `finalize`) | — |
| Set / Function / Function Item / Code / NoOp | `code` | — |
| Slack | `invoke` | `@skelm/integrations` (slack) |
| Telegram | `invoke` | `@skelm/integrations` (telegram) |
| GitHub | `invoke` | `@skelm/integrations` (github) |
| Microsoft Graph | `invoke` | `@skelm/integrations` (ms-graph) |
| OpenAI | `infer` | — |
| AI Agent | `agent` (permissions default-deny) | — |

Triggers are emitted under `triggers:` in the generated source. As with any
[workflow package](./workflow-packages.md), **triggers are offered, never
armed** — an operator must enable each one explicitly.

## Unsupported enabled nodes are flagged; disabled nodes are omitted

Every enabled n8n node either maps to a step or is flagged. A node with no
mapping becomes a loud placeholder in the skeleton:

```ts
// TODO(n8n): UNSUPPORTED node "Notion DB" (type "n8n-nodes-base.notion").
// No skelm mapping exists. Replace this placeholder with an equivalent step.
code({ id: "notionDb", run: () => {
  throw new Error("Unsupported n8n node not migrated: Notion DB (n8n-nodes-base.notion)")
} }),
```

The same names also appear in `MigrationResult.unsupported`, so a caller can
fail fast or surface the list. The importer never silently discards an enabled
node; disabled nodes are omitted intentionally.

### Mapping overrides

The package config accepts `integrationOverrides`: a map of n8n node `type` to a
skelm integration package name. An otherwise-unsupported node listed there is
mapped to an `invoke` against that integration instead of being flagged — handy
for pointing Notion/Postgres/Sheets nodes at a custom integration you maintain.

## Running the importer

The workflow's input is the n8n export (raw JSON text or a parsed object) plus
optional overrides; its output is the `MigrationResult`:

```ts
import { migrateN8nWorkflow } from '@skelm/migration-n8n'

const result = migrateN8nWorkflow(exportJsonText)
console.log(result.source)               // the reviewable skeleton
console.log(result.requiredIntegrations) // ['@skelm/integration-http', ...]
console.log(result.unsupported)          // node names you must address
```

## Public API

- `migrateN8nWorkflow(input, options?)` — the entrypoint.
- `parseN8nWorkflow(input)` — boundary parse/validate; throws `N8nImportError`.
- `mapNode` / `mapNodes` / `ruleForType` / `toStepId` — the mapping primitives.
- `generateSkeleton(pipelineId, nodes)` — emit the TypeScript skeleton string.
- `extractSampleInput` / `generateFixture` — test-fixture stub helpers.
- `N8nImportError` — the typed error for malformed input.
