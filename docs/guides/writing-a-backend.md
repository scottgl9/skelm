# Guide — writing a backend

A **backend** is a `SkelmBackend` implementation that powers `infer()` and `agent()` steps. Skelm ships in-tree backends for the major providers; this guide is for anyone integrating a private LLM, a custom agent runtime, or an enterprise model gateway behind skelm's SPI.

By the end of this guide you will have:

- A typed `SkelmBackend` implementation.
- The capability flags set correctly so the framework knows what your backend can enforce natively.
- A passing run against the backend-contract suite.
- A plugin package that ships your backend.

## The contract

```ts
// from @skelm/core
export type SkelmBackend = {
  id: string                                                 // unique id; e.g. 'mycorp-llm'
  label?: string

  capabilities: Capabilities

  inference(req: InferenceRequest, ctx: BackendContext): Promise<InferenceResponse>
  inferenceStream?(req: InferenceRequest, ctx: BackendContext): AsyncIterable<InferenceStreamEvent>

  run(req: AgentRequest, ctx: BackendContext): Promise<AgentResponse>
  runStream?(req: AgentRequest, ctx: BackendContext): AsyncIterable<AgentStreamEvent>

  dispose?(): Promise<void>
}
```

`inference` powers `infer()`; `run` powers `agent()`. A backend may implement only one. A backend that implements neither is not registerable.

## Capabilities — the contract behind the contract

```ts
type Capabilities = {
  prompt: boolean              // can do single-shot inference (drives infer())
  streaming: boolean           // supports inferenceStream / runStream
  sessionLifecycle: boolean    // long-lived sessions across turns
  mcp: boolean                 // can attach MCP servers per-run
  skills: boolean              // can load skills per-run natively
  modelSelection: boolean      // honors the `model` field on the step
  toolPermissions: 'native' | 'wrapped' | 'advisory' | 'unsupported'
}
```

`toolPermissions` is the most important field. Get it wrong and the security tenet breaks.

- **`'native'`** — your backend enforces `permissions.allowedTools` / `allowedExecutables` / `networkEgress` / `fsRead` / `fsWrite` itself. The framework hands you the resolved policy and trusts you. Choose this only if your backend is deeply integrated with permission enforcement at its tool-dispatch layer.
- **`'wrapped'`** — your backend surfaces tool calls to skelm; skelm checks against the policy, then forwards. Most backends fit here. The framework wraps every privileged call before the model sees a result.
- **`'advisory'`** — your backend accepts the resolved policy but cannot fully
  enforce it. This must be explicit, emits `permission.advisory` diagnostics,
  and still fails closed for network permissions unless the gateway egress
  proxy is active.
- **`'unsupported'`** — your backend cannot enforce permissions and cannot surface tool calls for skelm to wrap. This is acceptable for an LLM-only backend (no tool use); the framework refuses to start an `agent()` step against it if the step declares any tool-bearing permissions.

If you set `'native'` and your backend silently allows a denied tool call, you have a security defect. The framework's contract test will catch it; the security tenet fails-closed.

## Minimal example

A backend that talks to a hypothetical OpenAI-compatible endpoint:

```ts
// my-backend/src/index.ts
import type { SkelmBackend, InferenceRequest, InferenceResponse, BackendContext } from '@skelm/core'

export function createMyBackend(opts: { endpoint: string; apiKeySecret: string }): SkelmBackend {
  return {
    id: 'mycorp-llm',
    label: 'MyCorp internal model gateway',
    capabilities: {
      prompt: true,
      streaming: true,
      sessionLifecycle: false,
      mcp: true,
      skills: false,
      modelSelection: true,
      toolPermissions: 'wrapped',          // skelm wraps tool calls
    },

    async inference(req, ctx): Promise<InferenceResponse> {
      const apiKey = ctx.secrets.apiKey.read()    // one-shot accessor
      const res = await ctx.enforcer.fetch(new URL(opts.endpoint + '/v1/chat/completions'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: req.model ?? 'mycorp-default',
          messages: req.messages,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          response_format: req.outputSchema ? { type: 'json_schema', schema: req.outputSchema } : undefined,
        }),
        signal: ctx.signal,
      })
      const json = await res.json()
      return {
        text: json.choices[0].message.content,
        structured: req.outputSchema ? json.choices[0].message.parsed : undefined,
        usage: {
          inputTokens: json.usage.prompt_tokens,
          outputTokens: json.usage.completion_tokens,
        },
      }
    },

    async run(req, ctx) {
      // Multi-turn agent loop, calling tools through ctx.enforcer.canCallTool
      // Implementation omitted for brevity; see the full guide section below.
      throw new Error('run() not implemented in this minimal example')
    },
  }
}
```

Notes on what is and is not happening:

- **`ctx.enforcer.fetch`** — every outbound HTTP call goes through the trust enforcer. If the step's `networkEgress` does not permit `opts.endpoint`'s host, this call throws. You do not implement that check; the framework does.
- **`ctx.secrets.apiKey.read()`** — secrets come through one-shot accessors, not raw values. Calling `read()` once is normal; calling twice without `multi: true` is an error (which the framework catches in tests).
- **`ctx.signal`** — every long-running operation receives the abort signal. Propagate it to your fetch / WebSocket / subprocess so cancellation works.

## The agent loop (`run`)

For backends that support `agent()`, `run` drives the agent loop until the agent emits a final answer or hits `maxTurns`:

```ts
async run(req, ctx) {
  let turn = 0
  let messages = [...req.messages]

  while (turn < req.maxTurns) {
    turn++
    const response = await callTheModel({ messages, tools: req.tools })

    if (response.kind === 'final') {
      return { output: response.output, usage: response.usage, turns: turn }
    }

    if (response.kind === 'tool_call') {
      // CRITICAL: route through the enforcer.
      const decision = ctx.enforcer.canCallTool(response.toolId, response.args)
      if (!decision.allow) {
        // Feed the denial back to the model as a tool-result.
        messages.push({
          role: 'tool',
          tool_call_id: response.callId,
          content: JSON.stringify({ status: 'denied', reason: decision.reason }),
        })
        continue
      }

      const result = await ctx.mcpHost!.invokeTool(response.toolId, response.args, ctx.signal)
      ctx.enforcer.recordToolCall(response.toolId, response.args, result, /* duration */ 0)
      messages.push({
        role: 'tool',
        tool_call_id: response.callId,
        content: JSON.stringify(result),
      })
    }
  }

  throw new Error(`Agent did not terminate within ${req.maxTurns} turns`)
}
```

This pattern — model emits tool call → enforcer checks → MCP host invokes → result back to model — is what makes `toolPermissions: 'wrapped'` work. The framework guards every tool call without your backend having to know what the policy is.

## Handling `outputSchema`

When an `infer()` or `agent()` step declares an `output` schema, the framework requires structured output. Your backend's job:

- For `infer()` — request structured output from the underlying API (JSON mode, response schema, or whatever the API offers). Return the parsed structured value in `InferenceResponse.structured`.
- For `agent()` — when the agent emits a "final" response, validate it against the schema. If invalid, instruct the model to fix it (one retry) before throwing.

The framework re-validates the returned value before exposing it as the step output. Your backend's validation is belt; the framework is braces.

## The contract test

Every backend imports and runs the framework's contract suite:

```ts
// my-backend/test/contract.test.ts
import { runBackendContract } from '@skelm/core/testing'
import { createMyBackend } from '../src/index.ts'

const backend = createMyBackend({ endpoint: 'http://localhost:8080', apiKeySecret: 'TEST_KEY' })

runBackendContract(backend, {
  // Optional: skip suites that don't apply (e.g. agent loop if your backend is inference-only).
  skip: ['agent'],
})
```

The contract test asserts:

- `inference` honors `outputSchema` when supplied.
- Streaming yields events in the documented order.
- Cancellation propagates within 1 s.
- For `'wrapped'` backends: a denied tool call surfaces as a tool-result with the denial reason.
- For `'native'` backends: the policy is honored end-to-end.
- Errors are typed (`PermissionDeniedError`, `BackendTransientError`, `BackendHardError`).
- The backend reports `Usage` consistently.

If the contract suite fails, your backend is not ready. Do not register it.

## Distributing your backend

The simplest distribution path is an npm package whose default export is a factory (e.g. `createMyBackend(opts)`). Consumers then wire it into their own `skelm.config.ts` via `instances:`:

```ts
// consumer's skelm.config.ts
import { defineConfig } from 'skelm'
import { createMyBackend } from 'skelm-mycorp'

export default defineConfig({
  backends: { default: 'mycorp' },
  instances: [
    createMyBackend({
      endpoint: process.env.MYCORP_LLM_ENDPOINT ?? 'https://llm.mycorp.internal',
      apiKey:   { secret: 'MYCORP_API_KEY' },
      id:       'mycorp',
    }),
  ],
})
```

If you need lifecycle hooks (init / start / stop / health), implement the `SkelmPlugin` interface from `@skelm/core` and ship the package name in the consumer's `plugins:` config — see [`packages/core/src/plugins.ts`](https://github.com/scottgl9/skelm/blob/main/packages/core/src/plugins.ts) for the canonical interface.

```json
// my-backend/package.json
{
  "name": "skelm-mycorp",
  "version": "0.1.0",
  "skelm": {
    "compat": { "pluginApi": "1" },
    "build":  { "skelmVersion": "0.x" }
  },
  "main": "./dist/plugin.js",
  "exports": { ".": "./dist/plugin.js" }
}
```

Customers add it to their config:

```ts
// skelm.config.ts
import { defineConfig } from 'skelm'

export default defineConfig({
  plugins: ['skelm-mycorp'],
  backends: { 'mycorp-llm': { /* config that the backend factory consumes via env */ } },
  backend: 'mycorp-llm',
})
```

## Common mistakes

- **Setting `toolPermissions: 'native'` because it sounds better.** Don't. Use `'wrapped'` unless your backend really enforces every dimension itself. The framework cannot help you if `'native'` is wrong.
- **Reading the API key once and caching it.** Use `ctx.secrets.apiKey.read()` per call (or per session if the backend is session-lifecycle-capable). The accessor's auditability depends on real reads.
- **Using `fetch` instead of `ctx.enforcer.fetch`.** Direct `fetch` bypasses the network-egress check. CI guards this in skelm itself; your tests should guard it in your backend.
- **Throwing strings.** Throw typed errors from `@skelm/core/errors` so the framework's retry policy knows what to do.
- **Ignoring `ctx.signal`.** A backend that does not propagate the signal blocks gateway shutdown.

## Reference

- `SkelmBackend`, `Capabilities`, `BackendContext`, `InferenceRequest`, `AgentRequest` — [API → backends](../reference/api.md#backends).
- `runBackendContract` — [API → testing](../reference/api.md#testing).
- The plugin contract — [Writing a plugin](./writing-a-plugin.md).
