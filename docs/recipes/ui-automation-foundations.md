# UI automation foundations

skelm ships the two primitives a UI-test pipeline cannot build on its own:
image content parts threaded through to a vision LLM, and a binary
artifact store on the run record.

Everything else a UI driver needs (the actual screenshot/mouse/keyboard
adapter, named remote target sessions, structured verification records)
is left to user code or an external MCP server — keeping the framework
small.

This recipe shows the smallest end-to-end loop: **capture → describe →
decide**, with the screenshot stored as a run artifact for later evidence.

## What you get

- `imagePart` / `imagePartFromFile` / `textPart` — build multimodal prompts
  from `'skelm'`.
- `llm({ prompt: [...] })` — accepts a `ContentPart[]` for image-bearing
  prompts. Throws `BackendCapabilityError` if routed to a non-vision
  backend.
- `ctx.artifacts.put({ name, mimeType, data })` — persists bytes keyed by
  `{runId, stepId, name}`, emits a `tool.result` event for audit, enforces a
  default 256 MiB per-run quota.

## Sketch

```ts
import {
  code,
  imagePartFromFile,
  llm,
  pipeline,
  textPart,
} from 'skelm'

export default pipeline({
  id: 'ui-snapshot',
  steps: [
    // 1. Drive your UI adapter (Playwright, your own remote driver, …) and
    //    persist the PNG bytes as a run artifact.
    code({
      id: 'capture',
      run: async (ctx) => {
        const png = await captureScreenshot()      // your driver returns Uint8Array
        const desc = await ctx.artifacts!.put({
          name: 'screen.png',
          mimeType: 'image/png',
          data: png,
        })
        return { artifactId: desc.artifactId, path: writeTempPng(png) }
      },
    }),

    // 2. Ask a vision LLM what is on screen. The prompt is a multimodal
    //    ContentPart[] — anthropic and openai both declare capabilities.vision.
    llm({
      id: 'describe',
      backend: 'anthropic',
      prompt: async (ctx) => [
        textPart('You are inspecting a UI screenshot. Describe what is visible.'),
        await imagePartFromFile(
          (ctx.steps.capture as { path: string }).path,
        ),
      ],
    }),
  ],
})

declare function captureScreenshot(): Promise<Uint8Array>
declare function writeTempPng(bytes: Uint8Array): string
```

## Why these specific primitives?

Every UI-automation action → observe → verify loop hits the same two walls
before anything else:

1. **The screenshot has to land in the LLM as an image.** Without
   multimodal `PromptMessage`, the agent only sees a path or a base64
   blob in text — vision models can't act on that.
2. **The screenshot has to survive past the LLM context window** for
   evidence and replay. Without a binary artifact store, every pipeline
   reinvents per-step PNGs on disk by hand.

Adjacent concerns (phase-gated tools, named remote-target sessions,
structured verification records, retry / timeout / per-iteration loops)
are either already in skelm (`forEach`, `retry`, `timeoutMs`) or
buildable on top of these two foundations as user code or a separate
package.

## What is intentionally NOT in this PR

- **No remote-target adapter.** Screenshot/mouse/keyboard transport
  belongs in user code or an MCP server, not in core. The framework
  stays generic.
- **No per-phase tool gating.** `allowedTools` is still static per agent
  step; a state-machine variant is a separate proposal.
- **No verification-record builder.** Easy to model now that artifacts
  exist (a verification record is an artifact with a verdict) — but the
  right abstraction is best picked after a real pipeline uses the
  foundations.

## Verification

- `pnpm vitest run packages/core/test/content.test.ts` — content helpers.
- `pnpm vitest run packages/core/test/artifacts.test.ts` — artifact store
  contract + quota enforcement.
- `pnpm vitest run packages/core/test/artifacts-ctx.test.ts` — `ctx.artifacts`
  publishes the audit event without leaking bytes into the event log.
- `pnpm vitest run packages/core/test/backend.test.ts` — vision capability
  enforced; image parts are routed to vision-capable backends and rejected
  on others.
