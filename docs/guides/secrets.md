# Secrets

skelm resolves secrets through a gateway-owned `SecretResolver`. Pipeline source never holds a credential — it references a name (e.g. `{ secret: 'OPENAI_KEY' }`) and the gateway resolves it at call time. The fact of access is audited; the value is not.

## Drivers

| Driver | When | Backed by |
|--------|------|-----------|
| `env` | default | `process.env` (12-factor friendly) |
| `file` | opt-in via `secrets: { driver: 'file' }` in `skelm.config.ts` | `~/.skelm/secrets.json`, mode `0600` |
| `vault` | <!-- @planned M4 --> | HashiCorp Vault KV v2; see `VaultSecretResolver` in `@skelm/gateway` |

Override the file path with `secrets: { driver: 'file', file: '/path/to/secrets.json' }`.

Vault and cloud secret drivers land in M4+. The `VaultSecretResolver` shape is exported from `@skelm/gateway` today as a typed skeleton — every method throws `NotImplementedError` until the driver lands.

## CLI

```bash
skelm secrets list                          # names only
skelm secrets get OPENAI_KEY                # 'OPENAI_KEY: set' / 'OPENAI_KEY: not set' (no value)
skelm secrets set OPENAI_KEY --value sk-... # writes via the gateway; resolver-side
skelm secrets unset OPENAI_KEY              # removes
```

`skelm secrets` is gateway-mediated since the CLI-as-gateway-interface refactor. The plaintext value **never leaves the gateway process** over HTTP — `GET /secrets/:name` reports `{ name, set: true|false }`, not the value. Workflows resolve the actual value in-process through the gateway-side `SecretResolver`. The `skelm secrets get` command therefore reports existence (`set` / `not set`) rather than the raw plaintext; for the value itself, read the source of truth (e.g. `~/.skelm/secrets.json` with the file driver, which the gateway writes mode `0600`).

## Authoring guidance

### Configuring a backend with a secret

```ts
import { agent } from 'skelm'

export default agent({
  id: 'my-agent',
  backend: 'openai',
  apiKey: { secret: 'OPENAI_KEY' },
})
```

The runner asks the resolver for `OPENAI_KEY` at step start. If the resolver returns `undefined`, the step fails with `MissingSecretError` — the value is never logged.

### Reading a secret inside a step (`ctx.secrets`)

`code()`, `llm()`, and `agent()` steps can declare `secrets: [...]` and read each value via `ctx.secrets.get(name)` inside their user-supplied callbacks (`run`, `prompt`, `system`, `mcp`). The runner resolves every declared name through the `SecretResolver` **before** the callback runs and refuses to start the step if any name is missing.

```ts
import { code, llm, agent, pipeline } from 'skelm'

export default pipeline({
  id: 'summarize-ticket',
  steps: [
    code({
      id: 'lookup',
      secrets: ['JIRA_TOKEN'],
      run: async (ctx) => {
        const token = ctx.secrets!.get('JIRA_TOKEN')
        // … use token to call Jira; never log it
      },
    }),
    llm({
      id: 'summarize',
      backend: 'openai',
      secrets: ['INTERNAL_DOC_KEY'],
      prompt: (ctx) => `Codeword: ${ctx.secrets!.get('INTERNAL_DOC_KEY')}.\n\nSummarize the ticket below…`,
    }),
    agent({
      id: 'reply',
      backend: 'opencode',
      secrets: ['INTERNAL_DOC_KEY'],
      // Same `ctx.secrets.get()` access from prompt/system/mcp; the value is
      // also forwarded to the backend as AgentRequest.secrets for tool/exec
      // env-var injection.
      prompt: (ctx) => `Reply using internal codeword ${ctx.secrets!.get('INTERNAL_DOC_KEY')}.`,
      permissions: {
        allowedSecrets: ['INTERNAL_DOC_KEY'],
      },
    }),
  ],
})
```

Authorisation: when a step has `permissions: { allowedSecrets: [...] }`, the runner gates each declared name through `TrustEnforcer.canAccessSecret` and emits `permission.denied` (dimension `'secret'`) on a violation. Steps without an explicit `permissions` field skip this gate — the secret reaches the callback unconditionally.

Failure modes:

- Missing name in the resolver → `MissingSecretError` (run fails before the callback fires).
- No `SecretResolver` wired into `runPipeline()` → "step declares secret X but no SecretResolver is configured". The CLI wires `EnvSecretResolver` by default and `FileSecretResolver` when `secrets: { driver: 'file' }` is set in `skelm.config.ts`.
- Denied by `allowedSecrets` → `PermissionDeniedError`; no value reaches the callback.
