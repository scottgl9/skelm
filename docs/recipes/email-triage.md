# Recipe — email triage

Read inbound email, classify importance using project rules + LLM, flag important ones, summarize the rest into a daily digest. Runs continuously on a poll schedule; produces decision journals customers review weekly instead of scrolling email.

This recipe exercises:

- Poll trigger with watermark-based dedupe
- LLM step (no agent loop — single inference per item)
- `branch` for routing on classification
- Persistent state for "important sender" patterns
- Decision journals as the audit-friendly artifact

## Project layout

```
email-triage/
├── skelm.config.ts
├── workflows/
│   ├── triage.workflow.mts
│   └── digest.workflow.mts
├── sources/
│   └── inbox-poll.ts
├── secrets/
└── package.json
```

No `agents/` directory — this recipe uses `infer()` steps, not `agent()`. Most triage problems are classification, not action; an LLM-only flow is cheaper, faster, and easier to reason about.

## `sources/inbox-poll.ts`

```ts
import type { PollSource } from 'skelm'

export const inboxPoll: PollSource<{ id: string; from: string; subject: string; body: string; receivedAt: number }> = {
  id: 'inbox',
  fetch: async (ctx) => {
    const since = await ctx.state.get<number>('inbox-watermark') ?? Date.now() - 24 * 3600 * 1000
    const messages = await fetchInboxSince(since)
    if (messages.length > 0) {
      await ctx.state.set('inbox-watermark', Math.max(...messages.map((m) => m.receivedAt)))
    }
    return { items: messages }
  },
  dedupeKey: (m) => m.id,
}
```

## `workflows/triage.workflow.mts`

```ts
import { pipeline, code, infer, branch, forEach } from 'skelm'
import { z } from 'zod'

const message = z.object({
  id: z.string(),
  from: z.string(),
  subject: z.string(),
  body: z.string(),
  receivedAt: z.number(),
})

export default pipeline({
  id: 'email-triage',
  description: 'Classify each inbound message as important / informational / ignore.',
  input:  z.object({ items: z.array(message) }),
  output: z.object({
    flagged: z.array(z.object({ id: z.string(), reason: z.string() })),
    digestEntries: z.array(z.object({ id: z.string(), headline: z.string() })),
  }),
  steps: [
    forEach({
      id: 'classify',
      items: (ctx) => ctx.input.items,
      concurrency: 4,
      step: (item) => infer({
        id: 'classify-one',
        backend: 'openai',
        prompt: (ctx) => `
          Classify this email as one of: important, informational, ignore.
          Important = needs my attention within 24 hours.
          Informational = relevant but not actionable.
          Ignore = newsletter, automated, or off-topic.

          From: ${item.from}
          Subject: ${item.subject}
          Body: ${item.body.slice(0, 4000)}
        `,
        output: z.object({
          label: z.enum(['important', 'informational', 'ignore']),
          reason: z.string(),
          headline: z.string(),
        }),
      }),
    }),
    code({
      id: 'route',
      run: async (ctx) => {
        const items = ctx.input.items
        const classifications = ctx.steps.classify as Array<{ label: string; reason: string; headline: string }>

        const flagged: Array<{ id: string; reason: string }> = []
        const digestEntries: Array<{ id: string; headline: string }> = []

        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          const c = classifications[i]
          if (c.label === 'important') {
            flagged.push({ id: item.id, reason: c.reason })
          } else if (c.label === 'informational') {
            digestEntries.push({ id: item.id, headline: c.headline })
          }
          await ctx.state.append('decisions', {
            at: Date.now(),
            messageId: item.id,
            from: item.from,
            label: c.label,
            reason: c.reason,
          })
        }
        return { flagged, digestEntries }
      },
    }),
    code({
      id: 'notify',
      run: async (ctx) => {
        for (const f of ctx.steps.route.flagged) {
          await sendImportantNotification(f.id, f.reason)
        }
        return {}
      },
    }),
  ],
  finalize: (ctx) => ({
    flagged: ctx.steps.route.flagged,
    digestEntries: ctx.steps.route.digestEntries,
  }),
})
```

## `workflows/digest.workflow.mts`

A second workflow runs daily to compose the digest from the journal:

```ts
import { pipeline, code, infer } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'email-digest',
  description: 'Produce a daily digest from yesterday\'s informational emails.',
  input:  z.object({}),
  output: z.object({ digest: z.string(), entryCount: z.number() }),
  steps: [
    code({
      id: 'gather',
      run: async (ctx) => {
        const since = Date.now() - 24 * 3600 * 1000
        const entries: unknown[] = []
        for await (const e of ctx.state.read('decisions', { since })) {
          entries.push(e)
        }
        return { entries: entries.filter((e: any) => e.label === 'informational') }
      },
    }),
    infer({
      id: 'compose',
      backend: 'openai',
      prompt: (ctx) => `
        Compose a brief digest of today's informational emails.
        One bullet per email, grouped by sender. No more than 250 words total.
        Entries:
        ${JSON.stringify(ctx.steps.gather.entries, null, 2)}
      `,
      output: z.object({ digest: z.string() }),
    }),
    code({
      id: 'send',
      run: async (ctx) => {
        await sendDigest(ctx.steps.compose.digest)
        return {}
      },
    }),
  ],
  finalize: (ctx) => ({
    digest: ctx.steps.compose.digest,
    entryCount: ctx.steps.gather.entries.length,
  }),
})
```

## Schedule both

```sh
skelm schedule add workflows/triage.workflow.mts --poll inbox --id triage --overlap skip
skelm schedule add workflows/digest.workflow.mts  --cron '0 8 * * *' --id daily-digest

skelm gateway start
```

## Why each piece is here

- **No agent loop.** The classification is a single LLM call with structured output. Faster, cheaper, easier to evaluate than an agent loop. Save agents for problems that genuinely need tool use.
- **`forEach` with concurrency.** Classify multiple emails in parallel. The structured-output schema validates each result.
- **State as the source of truth.** The decision journal is what the user reviews. The triage workflow's job is to produce journal entries; the digest workflow's job is to consume them.
- **No persistent workspace.** Email triage has no filesystem state to keep around. `mode: 'ephemeral'` (the default if no workspace is declared) is appropriate.
- **No agent permissions** because there is no agent step. The LLM step's outbound call goes through the backend with no tool surface exposed.

## Reading the journal

```sh
# Recent decisions
skelm state journal triage decisions --since 7d --json

# Just important ones
skelm state journal triage decisions --since 7d --json | jq 'select(.label == "important")'
```

## Tuning

The `important` / `informational` / `ignore` labels are policy. Capture them in the workflow's prompt; iterate based on journal entries that look mis-classified. The `decisions` journal lets you audit thousands of decisions cheaply.

If you want to teach the triager about specific senders, add a `code()` step before `classify` that loads pattern overrides from `ctx.state.list('important-sender:')` and injects them into the prompt — turning a static rule into a learning loop without any agent involvement.
