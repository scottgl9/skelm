# Changelog

All notable changes to skelm are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the project is pre-1.0, minor versions may include breaking changes; breaking changes are always called out explicitly.

## [Unreleased]

## [0.3.3] - 2026-05-04

First public release on npmjs.com. Versions of all published packages are aligned at `0.3.3`.

### Added
- **Public packages on npmjs.com.** `skelm`, `@skelm/core`, `@skelm/cli`, `@skelm/gateway`, `@skelm/integrations`, `@skelm/metrics`, `@skelm/opencode`, `@skelm/otel`, `@skelm/pi`, `@skelm/scheduler`.
- **Pi backend** — full rewrite as an RPC client speaking the correct Pi protocol; tested live against `qwen36`.
- **Scheduler** — `skelm schedule add|list|stop|fire` CLI and `DELETE /schedules/:id` HTTP route; trigger dispatcher wired into the gateway lifecycle (cron/interval/webhook/poll/queue).
- **Default-deny guards** — `scripts/guards/default-deny-permissions.ts` enforces that every `AgentPermissions` field defaults to `undefined` (deny). `gateway-only-enforcement.ts` enforces that privileged actions route through the gateway. `public-export-baseline.ts` pins the public surface against churn.
- **Adversarial security tests** — per-dimension default-deny and explicit-mismatch denials are pinned.
- **Permission.denied event + audit row** on MCP attach denial.
- **VaultSecretResolver / PostgresRunStore seams** for M4 deployment-scale targets.
- **OpenTelemetry recipe** in `docs/recipes/`.

### Changed
- **CLI exposes a single `skelm` bin.** `@skelm/cli` no longer ships its own bin; the meta package `skelm` is the only published bin.
- **Gateway loads `skelm.config.ts` on start** and passes backend instances into the dispatcher.
- **`describe` command** uses the shared `describePipeline` from `@skelm/core`.

### Fixed
- **Copilot ACP integration** — error handling and session integration improvements.
- **Workflow path persistence** across run/resume cycles; opencode dispose cleanup; history defaults to the configured database.
- **Idempotent run IDs**, ACP concurrency races, `wait` semantics, and a `server.ts` parameter bug.
- **ACP backend model selection** + structured output fallback for legacy models.

### Security
- Default-deny is now structurally enforced by guards + adversarial fixtures rather than convention alone.

## [0.3.2] and earlier

Pre-public releases distributed via GitHub Packages and git tags. See `git log` for full history.

[Unreleased]: https://github.com/scottgl9/skelm/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/scottgl9/skelm/releases/tag/v0.3.3
