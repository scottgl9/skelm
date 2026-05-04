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
skelm secrets get OPENAI_KEY                # value to stdout
skelm secrets set OPENAI_KEY --value sk-... # writes ~/.skelm/secrets.json (0600)
```

The CLI uses the file driver directly, bypassing the running gateway. That keeps secret rotation possible without restarting the gateway and works even when the gateway isn't running.

## Authoring guidance

In a workflow:

```ts
import { agent } from 'skelm'

export default agent({
  id: 'my-agent',
  backend: 'openai',
  apiKey: { secret: 'OPENAI_KEY' },
})
```

The runner asks the resolver for `OPENAI_KEY` at step start. If the resolver returns `undefined`, the step fails with `MissingSecretError` — the value is never logged.
