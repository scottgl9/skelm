# Secrets

skelm resolves secrets through a gateway-owned `SecretResolver`. Pipeline source never holds a credential — it references a name (e.g. `{ secret: 'OPENAI_KEY' }`) and the gateway resolves it at call time. The fact of access is audited; the value is not.

## Drivers

| Driver | When | Backed by |
|--------|------|-----------|
| `env` | default | `process.env` (12-factor friendly) |
| `file` | opt-in via `secrets: { driver: 'file' }` in `skelm.config.ts` | `~/.skelm/secrets.json`, mode `0600` |
| `vault` | `secrets: { driver: 'vault' }` | HashiCorp Vault KV v2 over HTTP; `VaultSecretResolver` |
| `aws-secrets-manager` | `secrets: { driver: 'aws-secrets-manager' }` | AWS Secrets Manager `GetSecretValue`; `AwsSecretsManagerResolver` |

Override the file path with `secrets: { driver: 'file', file: '/path/to/secrets.json' }`.

All drivers implement the same gateway-owned `SecretResolver` (`resolve(name)`). The gateway resolves the value in-process and audits only the **name** — the value never reaches logs, audit, or error messages, and is never serialized over HTTP. This by-reference model is identical across drivers: pipeline source references `{ secret: 'NAME' }`; the gateway dereferences it at call time against whichever driver is configured.

### HashiCorp Vault (KV v2)

```ts
// skelm.gateway.ts
export default {
  secrets: {
    driver: 'vault',
    vault: {
      url: 'https://vault.internal:8200',
      // token omitted ⇒ read from the VAULT_TOKEN env var so it never
      // lives in config; prefer a short-lived credential in production.
      mount: 'secret', // KV v2 mount; default 'secret'
      prefix: 'skelm/', // optional per-environment namespace
      field: 'value',   // which key in the KV v2 data map; default 'value'
      cacheTtlMs: 30_000, // optional in-memory TTL cache (in-memory only)
    },
  },
}
```

`resolve('OPENAI_KEY')` issues `GET <url>/v1/<mount>/data/<prefix>OPENAI_KEY` with the token in the `X-Vault-Token` header (held privately, never logged). Nested secret names are preserved as path segments, but any `.` or `..` segment in the effective Vault path is rejected before the request is sent so prefix scoping cannot be escaped via URL normalization. A 404 returns `undefined` (unknown secret → `MissingSecretError` upstream); any auth/transport failure throws a typed `VaultSecretError` whose message carries the secret name and HTTP status only — never the value or the token.

### AWS Secrets Manager

Add the SDK dependency once (`@aws-sdk/client-secrets-manager`), then:

```ts
// skelm.gateway.ts
export default {
  secrets: {
    driver: 'aws-secrets-manager',
    awsSecretsManager: {
      region: 'us-east-1', // omitted ⇒ resolved from the AWS environment
      prefix: 'skelm/',    // optional secret-id prefix
      cacheTtlMs: 30_000,  // optional in-memory TTL cache (in-memory only)
    },
  },
}
```

Credentials come from the standard AWS provider chain (env vars, shared config, SSO, instance/container role) — they are owned by the SDK client and never logged. `resolve('OPENAI_KEY')` calls `GetSecretValue` and returns the `SecretString`. A `ResourceNotFound` returns `undefined`; any other failure throws a typed `AwsSecretsManagerError` carrying the secret name and the AWS error name only — never the value.

> The optional `cacheTtlMs` holds resolved values **in memory only** for the
> TTL window — never persisted to disk, never logged. Omit it (the default)
> to fetch fresh on every access.

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

`code()`, `infer()`, and `agent()` steps can declare `secrets: [...]` and read each value via `ctx.secrets.get(name)` inside their user-supplied callbacks (`run`, `prompt`, `system`, `mcp`). The runner resolves every declared name through the `SecretResolver` **before** the callback runs and refuses to start the step if any name is missing.

```ts
import { code, infer, agent, pipeline } from 'skelm'

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
    infer({
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

Authorisation: when a `code()` or `agent()` step has `permissions: { allowedSecrets: [...] }`, the runner gates each declared name through `TrustEnforcer.canAccessSecret` and emits `permission.denied` (dimension `'secret'`) on a violation. Once a step declares a `permissions` policy, an omitted `allowedSecrets` denies every declared secret (default-deny within the policy). The same gate binds every step kind — `code()`, `infer()`, and `agent()` — to the delegation ceiling when the step runs as a delegated child, so a child can never read a secret outside its parent's `allowedSecrets`. A top-level step that declares no policy (and no ceiling) skips the gate — the secret reaches the callback unconditionally.

Failure modes:

- Missing name in the resolver → `MissingSecretError` (run fails before the callback fires).
- No `SecretResolver` wired into `runPipeline()` → "step declares secret X but no SecretResolver is configured". The CLI wires `EnvSecretResolver` by default and `FileSecretResolver` when `secrets: { driver: 'file' }` is set in `skelm.config.ts`.
- Denied by `allowedSecrets` → `PermissionDeniedError`; no value reaches the callback.
