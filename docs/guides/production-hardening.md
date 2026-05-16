# Production hardening checklist

skelm ships with default-deny everywhere, but a deployed gateway still has
operational knobs that need attention before it's exposed to anything
untrusted. Walk this list before opening the gateway port to a network you
do not fully control.

## Authentication and tokens

- [ ] Bearer tokens generated with at least 256 bits of entropy.
- [ ] Tokens are scoped per consumer; no shared "service token".
- [ ] A token rotation cadence is set (90 days or shorter for production).
- [ ] Old tokens are revoked, not just superseded.
- [ ] No tokens in plaintext in the audit log; use `skelm audit query` to
      grep your environment for accidental exposure.

## Network position

- [ ] Gateway is fronted by a reverse proxy (nginx/Caddy/Traefik) that
      terminates TLS — the gateway itself listens on `127.0.0.1` only.
- [ ] Reverse proxy enforces rate limits and request size caps.
- [ ] Only the routes you actually use are exposed externally; admin
      endpoints (`/gateway/pause`, `/debug/*`) stay local-only.

## Filesystem and process

- [ ] Gateway runs as a dedicated, unprivileged user.
- [ ] Workspace directory (`.skelm/`) is owned by that user with `0700`.
- [ ] Secrets file (default `secrets.json`) is `0600` and audited via
      `skelm audit query --action secrets.*`.
- [ ] Disk quota or per-pipeline workspace limits are enforced at the OS
      layer; the runtime does not bound disk by itself.
- [ ] Process supervisor (systemd / launchd) restarts the gateway on
      crash; see `skelm gateway install --systemd`.

## Audit log

- [ ] Audit log path is on durable storage, not `/tmp`.
- [ ] An offsite copy is shipped at least daily (e.g. Vector → S3).
- [ ] Verify the chain integrity periodically:
      `skelm audit query --since <ts> --json | jq` and run the chain
      verifier against the file directly.
- [ ] Retention is set per your compliance regime (SOC 2 / HIPAA / etc.).

## Pipelines

- [ ] All pipelines run through `skelm validate <path>` in CI before
      deploy (see issue #38).
- [ ] Each pipeline declares its required `AgentPermissions` explicitly;
      omitted fields default-deny but explicit is clearer for review.
- [ ] Each `agent()` step declares its `secrets` allowlist; omission
      means the agent cannot resolve any secret.
- [ ] Long-running pipelines have `wait()` `timeoutMs` set — there is no
      global default.

## Approvals

- [ ] Production-affecting steps that mutate external state require
      approval gates.
- [ ] Approvers are a real list of humans, not a single shared account.
- [ ] Approval timeouts are set and tested — a forgotten approval should
      fail, not hang forever.

## Backends

- [ ] Backend API keys live in the secret resolver, not in env files
      checked into git.
- [ ] Per-backend rate limits and request caps are configured.
- [ ] If you use Postgres for `RunStore`, the user has DDL only on
      migration and DML otherwise.

## Observability

- [ ] `/metrics` is scraped by Prometheus or compatible.
- [ ] `/runs/:id/events` consumers (UI, Grafana) authenticate.
- [ ] Alert on: gateway 5xx rate, run-failure rate, audit-write errors.

## Pre-deploy smoke

- [ ] `skelm gateway start --foreground` cleanly starts and stops.
- [ ] `skelm validate <pipeline>` exits 0 for every shipped pipeline.
- [ ] Adversarial test: a request with no bearer token gets `401` from
      every endpoint except `/health` and `/metrics`.
- [ ] Adversarial test: a step that requests a permission it did not
      declare fails with a permission-denied audit row.

## Related

- [`.github/SECURITY.md`](https://github.com/scottgl9/skelm/blob/main/.github/SECURITY.md) — vulnerability reporting
- [`docs/reference/cli.md`](../reference/cli.md)
- [`docs/reference/http.md`](../reference/http.md)
- [OpenAPI spec](../reference/openapi.md)
