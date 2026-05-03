# Guide — writing a plugin

skelm plugins are regular npm packages that contribute **providers** (ModelProvider, AgentProvider), backends, hooks, secret drivers, or skill packs. The plugin contract is small, versioned, and trust-aware: a plugin runs in the same Node process as user code, so the contract is about *clear capability declaration*, not about sandboxing.

## When to write a plugin

- You want to publish a custom **ModelProvider** for LLM endpoints (OpenAI, vllm, sglang, ollama, custom APIs). See the [Provider architecture](../backends/README.md) for details.
- You want to publish a custom **AgentProvider** for coding agent SDKs (ACP, Opencode, Copilot SDK, custom agents).
- You want to ship reusable **skill packs** as an npm package customers install.
- You want to add a **hook** that observes runs (audit forwarder, custom metric, redaction).
- You want to provide a custom **secret driver** (Hashicorp Vault, AWS Secrets Manager, GCP Secret Manager, internal secrets service).

If you want to extend the **step kind taxonomy**, that is not a plugin extension point in v1. The taxonomy is fixed; the answer is composition via `code()` and `pipelineStep()`.

## Skeleton

```
skelm-mycontrib/
├── package.json
├── src/
│   ├── plugin.ts              — definePlugin entry
│   ├── hooks/
│   ├── backends/
│   ├── secret-drivers/
│   └── skills/                — directories of SKILL.md
├── tests/
└── README.md
```

## `package.json`

```json
{
  "name": "skelm-mycontrib",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/plugin.js",
  "exports": { ".": "./dist/plugin.js" },
  "skelm": {
    "compat": {
      "pluginApi": "1"
    },
    "build": {
      "skelmVersion": "0.x"
    }
  },
  "peerDependencies": {
    "skelm": "0.x"
  },
  "files": ["dist", "skills"]
}
```

The `skelm.compat.pluginApi` field is required and integer-versioned. Skelm refuses to load plugins with a mismatched `pluginApi` at gateway startup. Old plugins fail loudly until they update.

## `definePlugin`

```ts
// src/plugin.ts
import { definePlugin } from 'skelm/plugin'
import { redactingAfterStepHook } from './hooks/redact.ts'
import { vaultSecretDriver } from './secret-drivers/vault.ts'
import { MyModelProvider } from './providers/my-model.ts'
import { MyAgentProvider } from './providers/my-agent.ts'

export default definePlugin({
  id: 'skelm-mycontrib',
  version: '0.1.0',

  contributes: {
    providers: {
      models: [
        new MyModelProvider(), // For LLM inference
      ],
      agents: [
        new MyAgentProvider(), // For agent SDKs
      ],
    },
    hooks: {
      afterStep: redactingAfterStepHook,
    },
    secretDrivers: [vaultSecretDriver],
    skills: ['./skills'],   // directories scanned for SKILL.md
  },
})
```

`contributes` is a discriminated union of capability bundles. Pass only the keys you contribute; omit the rest.

## Hooks

Hook signatures:

```ts
type HookSet = {
  beforeStep?: (ctx: HookContext, step: StepInfo) => Promise<void> | void
  afterStep?:  (ctx: HookContext, step: StepInfo, result: StepResult) => Promise<void> | void
  onError?:    (ctx: HookContext, step: StepInfo, error: SerializedError) => Promise<void> | void
  beforeRun?:  (ctx: HookContext, run: RunSummary) => Promise<void> | void
  afterRun?:   (ctx: HookContext, run: Run) => Promise<void> | void
}
```

A hook receives a `HookContext` (logger, run id, step id, pipeline id) and the relevant payload. Hooks **observe**; they do not mutate step output. To shape output, write a wrapping `code()` step.

Example: a redacting `afterStep` hook that strips API tokens from logs:

```ts
// src/hooks/redact.ts
import type { HookContext, StepInfo, StepResult } from 'skelm/plugin'

export function redactingAfterStepHook(ctx: HookContext, step: StepInfo, result: StepResult) {
  if (step.kind === 'agent' || step.kind === 'llm') {
    const output = result.output as Record<string, unknown>
    if (typeof output?.text === 'string') {
      output.text = output.text.replace(/sk-[A-Za-z0-9-]{20,}/g, '[redacted-token]')
    }
  }
}
```

Hook order is plugin-load-order. If two plugins both register `afterStep`, both run, in the order they appear in `skelm.config.ts.plugins`.

## Secret drivers

```ts
// src/secret-drivers/vault.ts
import type { SecretDriver, SecretDriverContext } from 'skelm/plugin'

export const vaultSecretDriver: SecretDriver = {
  id: 'vault',
  init: async (cfg: { url: string; tokenSecret?: string }, ctx: SecretDriverContext) => {
    const client = await connectVault(cfg.url, ctx.bootstrapToken)
    return {
      async resolve(name) {
        const path = `secret/data/skelm/${name}`
        const r = await client.read(path)
        return r.data.value
      },
      async list() {
        return await client.list('secret/metadata/skelm')
      },
    }
  },
}
```

Secret drivers receive a bootstrap context — the *initial* secrets needed to connect to the secrets backend itself (a Vault token, a cloud-provider credential). Bootstrap secrets always come from the env driver (chicken-and-egg avoidance).

Drivers expose a small read interface; they never expose write or delete over the gateway HTTP surface.

## Skill packs

A skill pack is a directory of `SKILL.md` files inside the plugin's package. Customers reference them by id once the plugin is loaded.

```
skelm-mycontrib/
└── skills/
    ├── github-write/SKILL.md
    └── slack-notify/SKILL.md
```

`contributes.skills: ['./skills']` registers the directory; the framework scans for `*/SKILL.md` and indexes them.

Customers reference packaged skills by id from any agent step:

```ts
agent({
  id: 'work',
  skills: ['github-write', 'slack-notify'],
  ...
})
```

The skill resolver looks up plugin-contributed skills after project-local and workspace skills (so customers can override packaged skills locally without forking the plugin).

## Capability-scoped runtime

Plugins receive only what they need. There is no global skelm object.

- A backend's `BackendContext` contains `signal`, `logger`, `enforcer`, `secrets`, `mcpHost?`, `state`, `workspace?`, `tracer?`. Nothing else.
- A hook's `HookContext` contains `logger`, identifiers, and a read-only handle to the run.
- A secret driver's `SecretDriverContext` contains the bootstrap secret accessor and a logger.

This narrowness is by design. Plugins that need access to other gateway internals are over-reaching; the right move is to surface a typed seam in `@skelm/core` rather than to widen what plugins can touch.

## Trust posture

Plugins run in-process with full filesystem and network access. Skelm does NOT pretend plugins are sandboxed. Mitigations live elsewhere:

- The agent permission model gates what a *backend can do during an agent step* — that's the part of plugin behavior the framework does enforce.
- `skelm gateway status --json` lists loaded plugins and their declared contributions for review.
- `skelm.config.ts.plugins` is reviewed in source control; we do not auto-discover plugins from `node_modules`.

Customers should vet plugins like any other production dependency.

## Versioning the plugin API

`pluginApi: '1'` is v1 of the plugin contract — supported through skelm v1.x. A breaking change to `definePlugin`, `SkelmBackend`, `HookSet`, or `SecretDriver` shapes bumps `pluginApi`. Old plugins fail to load with a clear message.

Skelm publishes a per-version compat matrix. Plugins should test against the lowest skelm version they support.

## Testing

Plugins import the framework's testing utilities:

```ts
// tests/plugin.test.ts
import { createTestGateway } from '@skelm/gateway/testing'
import myPlugin from '../src/plugin.ts'

test('plugin loads, hooks fire, backends register', async () => {
  const gateway = await createTestGateway({
    plugins: [myPlugin.default],
    inMemory: true,
  })

  const status = gateway.status()
  expect(status.plugins.find((p) => p.id === 'skelm-mycontrib')).toBeDefined()
  expect(status.backends.map((b) => b.id)).toContain('mycorp-llm')

  await gateway.stop()
})
```

For backends, also run the [backend-contract suite](./writing-a-backend.md#the-contract-test).

## Publishing

```sh
npm publish
```

Encourage users to pin the plugin version in their `skelm.config.ts.plugins` array and bump deliberately. Plugins that touch security paths (secret drivers, hooks that observe denied tool calls) deserve change-review; semver alone is not enough signal.

## Cross-references

- [Writing a backend](./writing-a-backend.md) — the most common plugin contribution.
- [Concepts → permissions](../concepts/permissions.md) — how customer-side permissions interact with backend-contributed enforcement.
- [API → plugins](../reference/api.md#plugins) — `definePlugin`, `HookSet`, `SecretDriver` types.
