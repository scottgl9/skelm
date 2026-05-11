# Changelog

All notable changes to skelm are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the project is pre-1.0, minor versions may include breaking changes; breaking changes are always called out explicitly.

## [Unreleased]

### Added
- **`invoke()` step** — call any registered pipeline by id from inside another workflow. The runner resolves the target through a `pipelineRegistry` callback (in-process tests supply their own; the gateway wires one automatically from `Gateway.registries.workflows` with a fallback scan that matches by `pipeline.id` when the registry id lookup misses). Throws `InvokePipelineNotFoundError` when the id is unknown. Nested runs inherit the parent's store, permissions, secret resolver, audit writer, and egress-proxy wiring.
- **`ctx.secrets` in `code()` / `llm()` / `agent()` callbacks** — steps that declare `secrets: [...]` now expose a `get(name)` accessor inside `run`, `prompt`, `system`, and `mcp` callbacks. Names are resolved through the `SecretResolver` and (when the step declares `permissions: { allowedSecrets }`) gated by `TrustEnforcer.canAccessSecret` before the callback runs. Missing names fail with `MissingSecretError`; denied names fail with `PermissionDeniedError`. For `agent()` steps the values are also forwarded to the backend as `AgentRequest.secrets` for tool/exec env-var injection.
- **`step.partial` streaming events** — backends that opt into streaming (`vercel-ai`, `@skelm/pi` SDK, `@skelm/opencode`) emit incremental output through `onPartial(delta)`; the runner publishes each chunk as a `step.partial` event on the bus, observable via `skelm run … --events json`.
- **CLI `SecretResolver` wiring** — `skelm run` now instantiates `FileSecretResolver` (driver `'file'`, honouring `SKELM_STATE_DIR` / `~/.skelm/secrets.json`) or `EnvSecretResolver` based on `skelm.config.ts` and passes it to `runPipeline()`. Previously the CLI path always failed agent/llm/code steps that declared `secrets: [...]` with "no SecretResolver is configured".
- **CLI gateway `loadWorkflow`** — `skelm gateway start` now passes its tsImport-based workflow loader to the `Gateway` constructor as well as the trigger dispatcher. Without this, `POST /pipelines/:id/run` returned 501 and invoke() targets could not be resolved over HTTP.

## [0.3.7] - 2026-05-06

### Added
- **`skelm logs` command** — operational log sink with ring-buffer and file backend; `skelm logs [--lines N] [--since iso] [--level lvl] [--filter substring] [--json]` reads `~/.skelm/gateway.log`. Logs are redacted of secrets at write time.
- **`skelm validate`** — static workflow analysis that catches permission gaps, missing step IDs, bad secret names, and schema errors before runtime. Emits structured `--json` output; exits 1 on any issue.
- **`timeoutMs` on `agent()` steps** — per-step deadline with `AbortController` propagation to backends; cooperative with the existing retry policy.
- **`ctx.get<T>(stepId)`** — typed step-output accessor as a self-documenting alternative to `ctx.steps[id] as T`.
- **Backend fallback chains** — `backend: ['primary', 'fallback']` on `agent()` and `llm()` steps; falls through on `BackendUnavailableError`, `BackendNotFoundError`, and `BackendCapabilityError`; emits `backend.fallback` audit events; raises `BackendChainExhaustedError` on full exhaustion.
- **`agentDef` on `agent()` steps** — `agentDef: './agents/<name>'` resolves `AGENTS.md` + optional `SOUL.md`; path-traversal outside the root is rejected; backends prepend soul + instructions to the system prompt.
- **Declared secrets on `agent()` steps** — `secrets: ['NAME']` declares what a step needs; the runner gates each name through `canAccessSecret`, resolves via `RunOptions.secretResolver`, and passes the record to backends. A `secret.accessed` event records name and timestamp (never value). Missing secrets raise `MissingSecretError`.
- **Layered skill resolver** — gateway resolves skills via registry → workflow-relative `skills/<id>/SKILL.md` → configured `skillsDir`; `createSkillSource` helper exported from `@skelm/gateway`.
- **`secret.not_found` audit event** — emitted when `resolveDeclaredSecrets` gets `undefined` from the resolver; value is never included.
- **`EXIT.STEP_TIMEOUT (7)`** exit code; `PermissionDeniedError` maps to `EXIT.PERMISSION_DENIED` and `StepTimeoutError` to `EXIT.STEP_TIMEOUT`.
- **Changesets + changelog-present guard** — `pnpm guards:changeset` fails CI when a source-touching PR omits a `.changeset/` entry (opt out with `[skip changeset]` in the PR body).
- **`docs/reference/`** — CLI reference, HTTP surface index, OpenAPI 3.1 spec, and a production hardening checklist.
- **Control-flow property tests** — sweeps `parallel`, `forEach`, `branch`, and `loop` across varied cardinalities; resolves previously skipped `wait`/resume event-ordering case.
- **Audit-chain adversarial tests** — tamper, drop, reorder, and re-sign cases against `ChainAuditWriter`.

### Changed
- **`RunStore` split into `ExecutionStore` + `StateStore`** — two focused interfaces; `RunStore` is now a type alias for backward compat.
- **Runner step-dispatch refactor** — `runLlmStep` and `runAgentStep` extracted from an inline switch; dispatcher is now ~20 lines.
- **Wildcard re-exports replaced with explicit named exports** — 39 previously invisible symbols are now tracked by the public-export baseline guard.
- **Gateway HTTP routes split** — `control-routes.ts` (951 LOC) decomposed into 11 per-resource modules under `http/routes/`; no behavior change.
- **`skelm run` wires `skillSource`** — `SkillRegistry` is instantiated from `config.registries?.skills?.glob` and passed into `runPipeline`; `skillSource` and `secretResolver` now propagate through nested pipeline steps.
- **`dispatchEvent()` propagates errors** — integration handler errors no longer swallowed as `{ error: string }` results.
- **`drop sourceMap`/`declarationMap`** from published tarballs — smaller install footprint.
- **README restructured** — features grouped into Authoring / Security & isolation / Integrations / Operations; project logo added.

### Fixed
- **`permission.denied` on backend defense-in-depth `PermissionDeniedError`** — backends that throw `PermissionDeniedError` from their own `run()` guard now emit a `permission.denied` event before the error propagates, making them auditable.
- **Pi RPC honest enforcement** — Pi RPC backend now declares `toolPermissions: 'unsupported'`; any step with permissions against it fails closed at capability-check time. Defense-in-depth guard in `run()` rejects any non-`undefined` `ResolvedPolicy`.
- **Pi SDK `llm()` support** — `pi-sdk` backend now implements `infer()` with `noTools: 'all'`; supports `outputSchema` by parsing fenced JSON from the response.
- **`skelm run` skill loading** — `skillSource` was never passed to `runPipeline`; agent steps with `skills: [...]` silently had no skill content. Fixed, with propagation through nested pipeline steps.
- **Pi SDK `networkEgress: 'deny'`** — drops `bash` from the Pi tool allowlist when `networkEgress` is `deny`, blocking `curl`/`wget` as the only network path available to Pi agents.
- **Integration error propagation** — `dispatchEvent()` auth failures and handler errors now surface to callers instead of being silenced.
- **`eventToRunInput` type-safety** — changed from a `typeof` duck-check to the typed optional method on the `Integration` interface.

### Security
- Pi RPC backend now fails closed (`toolPermissions: 'unsupported'`) — workflows with any permission declaration against Pi RPC get a capability error before any backend runs. Switch to `pi-sdk` for permission-scoped Pi workflows.
- `permission.denied` event and audit entry are now emitted for `BackendCapabilityError` (capability-check denial) and for `PermissionDeniedError` thrown from inside `backend.run()`, closing two audit-blind spots.
- Pi SDK enforces `networkEgress: 'deny'` by dropping `bash` from the tool allowlist (Pi's only outbound network path).

## [0.3.6] - 2026-05-05

Publish-pipeline fixes on top of 0.3.5.

### Fixed
- **`skelm init` scaffolds correct version** — the generated `package.json` now stamps the current skelm version instead of a hardcoded `^0.1.0`.
- **Publish: provenance, visibility, and bin permissions** — `npm publish --provenance` is skipped in local environments; `@skelm/cli` visibility corrected; the `skelm` bin is `chmod +x` on publish.

## [0.3.5] - 2026-05-05

### Added
- **Pi SDK backend** — `pi-sdk` backend with native tool allowlist enforcement via Pi's `tools[]`/`noTools` API; system prompt injection and per-agent sandbox defaults.
- **opencode backend improvements** — non-blocking `promptAsync`+SSE streaming; `OPENCODE_CONFIG_CONTENT` injection at spawn time for model/logLevel config; `serverPermissions` field for server-level bash/edit/webfetch defaults.
- **Core permission enforcement wired** — runtime call sites for `canLoadSkill`, `canRead`, `canWrite`, and expanded `canExec` are now active.
- **skelm Agent Skill** — published at `docs/skill/skelm` for use as a Claude Code skill.
- **VitePress documentation site** — scaffolded at `docs/`; `PUBLISHING.md` and publish scripts added.

### Changed
- **`@skelm/cli` is private** — the meta-package `skelm` is the only published bin entry point.

### Fixed
- **`skelm --version`** reads from `package.json` instead of a hardcoded constant.
- **opencode message filtering** — user message text no longer leaks into the collected response; assistant messages are tracked by role-filtered message ID allowlist.
- **opencode system prompt** — `request.system` is now forwarded to `session.promptAsync`.
- **Pi peer dep and permission semantics** — tightened peer dependency range; sdk-client test coverage; `defaults.backend` corrected.

## [0.3.4] - 2026-05-05

Republish of 0.3.3 with workspace-dependency rewriting fixed.

### Fixed
- **Published tarballs no longer ship `workspace:*` deps.** The 0.3.3 tarballs included `"@skelm/core": "workspace:*"` etc., which made `npm install skelm` fail with `EUNSUPPORTEDPROTOCOL`. The publish path now rewrites every `workspace:*` to a concrete `^X.Y.Z` range on disk before `npm publish` runs, with a trapped restore so the working tree returns to its pre-publish state. See `scripts/rewrite-workspace-deps.mjs` and the updated `scripts/publish-npm.sh` / `.github/workflows/publish.yml`.

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

[Unreleased]: https://github.com/scottgl9/skelm/compare/v0.3.7...HEAD
[0.3.7]: https://github.com/scottgl9/skelm/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/scottgl9/skelm/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/scottgl9/skelm/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/scottgl9/skelm/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/scottgl9/skelm/releases/tag/v0.3.3
