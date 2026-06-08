# @skelm/gateway

> The long-running orchestrator at the heart of [skelm](https://github.com/scottgl9/skelm) — owns config, registries, permission enforcement, audit, agent lifecycle, and the HTTP surface.

[![npm](https://img.shields.io/npm/v/@skelm/gateway)](https://www.npmjs.com/package/@skelm/gateway)

Part of [skelm](https://github.com/scottgl9/skelm).

The gateway is the canonical trust boundary and the home of every persistent concern:

- **Config** — loads `skelm.config.ts`, watches for changes, hot-reloads on edit or `SIGHUP`.
- **Registries** — workflows, skills, MCP servers, agents (ACP + coding agents), triggers.
- **Enforcement** — permission resolution, secret resolution, hash-chained audit log, approval gating.
- **Process & session lifecycle** — supervises resident coding agents (e.g. `opencode serve`), spawns ephemeral agents per step, persists ACP sessions across restarts.
- **HTTP surface** — sync / async runs, SSE event streams, idempotency, approvals, sessions.
- **Scheduler** — fires cron / interval / webhook / poll / queue triggers into registered workflows.

## Install

```bash
npm install @skelm/gateway
```

The gateway is normally driven through the `skelm` CLI:

```bash
skelm gateway start --foreground   # Run the gateway in this process (Ctrl-C drains and exits)
skelm gateway start                # Print how to run it (install, or --foreground)
skelm gateway status               # Inspect a running gateway
skelm gateway stop                 # Stop it (sends SIGTERM, waits for drain)
skelm gateway install              # Install as a service; auto-detects systemd (linux) / launchd (macOS)
```

There is no separate `skelm-gateway` executable — the gateway always runs from the single `skelm` bin.

## Programmatic use

```ts
import { createGateway } from '@skelm/gateway'

const gateway = await createGateway({
  configPath: './skelm.config.ts',
  http: { host: '127.0.0.1', port: 4711 },
})

await gateway.start()
// ...
await gateway.stop()
```

## HTTP surface

The HTTP API speaks JSON over `h3`, with SSE for run event streams.

| Method | Path                                | Purpose                              |
| ------ | ----------------------------------- | ------------------------------------ |
| `GET`  | `/health`                           | Liveness                             |
| `GET`  | `/registry/workflows`               | List registered workflows            |
| `POST` | `/runs`                             | Start a run (sync or async)          |
| `GET`  | `/runs/:id`                         | Fetch a run by id                    |
| `GET`  | `/runs/:id/events`                  | SSE stream of run events             |
| `POST` | `/runs/:id/cancel`                  | Cancel an in-flight run              |
| `POST` | `/approvals/:id/{approve,deny}`     | Resolve a pending approval           |
| `GET`  | `/audit`                            | Tamper-evident, hash-chained audit   |
| `GET`  | `/v1/dashboard/*`                   | Read-only aggregations for dashboards ([demo](https://github.com/scottgl9/skelm/tree/main/examples/dashboard-demo)) |
| `GET`  | `/v1/workflows`                     | List explicitly registered workflows |
| `GET`  | `/v1/workflows/health`              | Workflow readiness, run counts, active runs, failures, and trigger state |
| `GET`  | `/v1/workflows/:id/health`          | Readiness and status for one workflow |
| `POST` | `/v1/workflows/{validate,register}` | Compile-check or register a workflow — JSON `{ source: { type: "path", path } }` or a `multipart/form-data` `.zip` upload |
| `PUT`/`DELETE` | `/v1/workflows/:id`         | Replace / unregister a registered workflow |
| `POST` | `/v1/batch/{runs,cancel}`           | Fan-out start / cancel; per-item outcome with stable `description` category; default 50-item cap (configurable via `GatewayOptions.batch.maxItemsPerRequest`) |
| `GET`/`PATCH` | `/v1/config`                 | Sanitized config + hot-update whitelist |

See [`docs/reference/`](https://github.com/scottgl9/skelm/tree/main/docs/reference) for the full schema, and [`docs/guides/production-hardening.md`](https://github.com/scottgl9/skelm/blob/main/docs/guides/production-hardening.md) for the production deployment checklist (reverse proxy, Postgres, secrets).

## Why a separate package?

The runtime + builders (`@skelm/core`) are small and dependency-light by design. Spinning up an HTTP server, a SQLite/Postgres run store, an audit chain, an approval queue, and a scheduler costs more — both in install size and in setup complexity. Pulling those into a separate package keeps the meta `skelm` package small for users who only want to author and run workflows from the CLI.

## Stability

`0.x` — APIs may change between minor versions until v1.

## Contributing

See the [contributing guide](https://github.com/scottgl9/skelm/blob/main/.github/CONTRIBUTING.md).

## License

[MIT](LICENSE)
