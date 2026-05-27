# System prompt construction

Every skelm agent backend that accepts a top-level system prompt builds it through one shared function: `buildSystemPrompt` in `@skelm/core/system-prompt`. The builder is a pure function with no I/O — backends pass it the current cwd, platform, date, tool list, skill summaries, and MCP server inventory, and it returns a single string.

## Why this exists

Before this lived in core, every backend had its own ad-hoc composition (`soul + instructions + system + skill blocks`, joined by separators) and the first-party `@skelm/agent` backend was building a prompt and then immediately discarding it. The new builder is a single source of truth that:

- gives a tool-capable model a competent default system prompt — informed by surveying established tool-capable agents,
- stays compact (the built-in default sections are capped at 5000 characters, guarded by a test),
- composes cleanly with AGENTS.md / SOUL.md / user overrides,
- escapes dynamic content (tool/skill names, paths) so the prompt can't be hijacked by adversarial tool metadata.

## Sections

In `extend` mode (the default), the prompt is assembled in this order:

| # | Section | Purpose |
|---|---|---|
| 1 | Identity | One sentence describing the agent. |
| 2 | `<env>` | cwd, platform, date, model. |
| 3 | Tool use | Don't fabricate; call a tool; prefer specific over `exec`; verify mutations; stop when done. *Omitted if no tools.* |
| 4 | Available tools | `<tools>` XML inventory of all built-in + MCP tools, XML-escaped names + first-sentence descriptions. *Omitted if no tools.* |
| 5 | Skills | `<skills>` XML inventory of available skills, with `<location>` so the model can fetch the body on demand. *Omitted if no skills.* |
| 6 | MCP servers | Note about `<serverId>.<toolName>` namespacing and per-server tool counts. *Omitted if no MCP.* |
| 7 | Safety | Default-deny is gateway-enforced; surface blocks rather than working around them. |
| 8 | Tone | Concise; `file:line` references; no emojis; no trailing summaries. |
| 9 | Coding work | Read before write; focused edits; root-cause; tests are not optional. |
| 10 | `# SOUL.md` | Verbatim, if present. |
| 11 | `# AGENTS.md` | Verbatim, if present. |
| 12 | `# Instructions` | The user's `step.system`, verbatim, if present. |

Sections 10–12 come **last** so user-authored content carries the recency weight LLMs give to nearby text.

## Customizing the prompt

Three layers of customization, from least invasive to most:

### 1. AGENTS.md / SOUL.md (per-agent persona and instructions)

Author them in the directory referenced by `step.agentDef`:

```ts
agent({
  id: 'support',
  agentDef: './agents/support',   // contains AGENTS.md (+ optional SOUL.md)
  prompt: ({ ctx }) => ctx.input.question,
})
```

These get appended after the built-in default sections.

### 2. `step.system` (per-step extension)

Adds another `# Instructions` block, after AGENTS.md, with whatever you pass:

```ts
agent({
  id: 'support',
  prompt: '...',
  system: 'For this run, prefer concise answers over thorough ones.',
})
```

### 3. Full replace

If the built-in default is wrong for your use case (you're talking to a specialized model with its own conventions, you want a JSON-only protocol, etc.), opt out entirely:

```ts
agent({
  id: 'json-extractor',
  prompt: '...',
  system: 'You output only valid JSON matching the requested schema. No prose.',
  systemPromptMode: 'replace',           // drop sections 1–9
  systemPromptIncludeAgentDef: false,    // and AGENTS.md/SOUL.md too
})
```

With `systemPromptMode: 'replace'` and `systemPromptIncludeAgentDef: true` (default), the built-in default is dropped but AGENTS.md/SOUL.md are still injected — useful when the persona matters but the framework's tool/safety/tone guidance doesn't fit.

## Per-backend behavior

| Backend | Default behavior |
|---|---|
| `@skelm/agent` | Built-in default prompt with dynamic tool / skill / MCP inventory, prepended as `{role: 'system'}` at the head of `messages`. |
| `@skelm/core` anthropic | Built-in default (tool sections skipped — anthropic's `run()` is single-shot, not tool-dispatching). Full skill bodies appended after the inventory so the model still has the skill instructions. |
| `@skelm/core` openai | `infer()` only — passes `req.system` through unchanged. No agent loop, so no built-in default. |
| `@skelm/core` acp | Forwards prompts to a Claude-Code-compatible subprocess, which has its own system prompt. `req.system` is concatenated with the user prompt as-is. |

### `agent()` steps vs. `llm()` steps

The builder runs on the **agent loop path only** — i.e. `agent()` steps, which route to a backend's `run()`. Single-shot `llm()` steps route to `infer()`, which passes `req.system` through unchanged and does **not** inject the default sections. `systemPromptMode` and `systemPromptIncludeAgentDef` are therefore no-ops on `llm()` steps: the only system content on those calls is whatever the caller supplies.

If you need the default tool-use / safety / coding guidance on a single-shot call, write it into `system` yourself, or convert the step to an `agent()` with `maxTurns: 1`.

## Length budget

The built-in default sections (Identity through Coding work) are budget-capped at 5000 characters. A unit test (`packages/agent/test/prompt.test.ts`) regresses on this so future edits don't bloat the prompt. AGENTS.md / SOUL.md / `system` are user content and have no cap.

## Reference

- `packages/core/src/system-prompt.ts` — builder
- `packages/agent/test/prompt.test.ts` — unit tests
- `packages/core/test/anthropic/backend.test.ts` — anthropic adoption tests
- `scripts/validate-prompt-qwen36.ts` — manual end-to-end validation against a local qwen36 (llama.cpp default; override with `SKELM_QWEN36_URL`).
