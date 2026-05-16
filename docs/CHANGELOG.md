# Changelog

All notable changes to skelm are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the project is pre-1.0, minor versions may include breaking changes; breaking changes are always called out explicitly.

## [Unreleased]

## [0.3.9] - 2026-05-16

### Added
- **`@skelm/codex` backend** (#106) — new first-party backend wrapping the Codex SDK. Includes a permission mapper that translates skelm policy into Codex SDK options, a client wrapper + run loop covering skelm's full feature surface (tools, skills, MCP, secrets, streaming deltas), `codex` backend registration in the CLI, a backend-contract suite, and a live integration test with skill-injection coverage. Package README and `docs/backends/codex.md` ship with the release.
- **`@skelm/integration-sdk`** — extracted authoring SDK with `defineIntegration()` so third parties can build integrations without depending on `@skelm/integrations` internals. `@skelm/integrations` (GitHub, Slack) is rewritten on top of this SDK.
- **Sectioned system-prompt builder** — `@skelm/agent` replaces the prompt stub with a sectioned builder; the implementation is hoisted to `@skelm/core` and adopted by the Anthropic backend. New `systemPromptMode` and `systemPromptIncludeAgentDef` fields on `AgentStep` control how the agent definition and built-in sections are composed.
- **Gateway workflow registration API** — `/v1/workflows` registers workflows over HTTP, including registration from `.zip` archive uploads. `loadPipelineFromPath` extracted for reuse.
- **Gateway `/v1/batch/*` and `/v1/config` routes** — batch run dispatch and runtime config inspection endpoints, documented under `docs/gateway/`.
- **Gateway dashboard API** (`/v1/dashboard/*`) — read-only aggregations composed from the run store, registries, trigger coordinator, and approval gate. Endpoints: `overview`, `workflows`, `runs`, `analytics` (time-bucketed), `errors`, `schedules`, `approvals`. Five-second in-memory TTL on overview and analytics. Same bearer auth as the rest of the control surface. Reference dashboard demo under `examples/dashboard-demo/`.
- **`RunFilter.startedAfter` / `RunFilter.startedBefore`** — date-range filtering on `listRuns()`, pushed into the SQL `WHERE` clause for the SQLite-backed store. Powers the analytics endpoint without scanning the full run table.
- **`triggerId` recorded on runs** — `core`/`gateway` persist the originating trigger id on every run; `GET /v1/runs?triggerId=…` filters accordingly.
- **CLI gateway lifecycle UX** — `skelm gateway start --detach` and `--http-port`, plus `status` now performs a real pid-alive check. `skelm init` merges into an existing `npm init`-created directory rather than refusing to run.
- **`skelm approvals config` CLI** — manage the approval policy file:
  - `skelm approvals config show [--json]` — print the effective policy.
  - `skelm approvals config validate [--json]` — static-check the policy (parse error, bad timeout, unknown step kind, duplicate approver id, missing approver id).
  - `skelm approvals config set <key> <value>` — set `defaultTimeoutMs` or `stepKindsRequiringApproval` (comma-separated list); writes are atomic via tmp+rename.
  - `skelm approvals config approvers add|remove <id>` — manage the approver registry.

  Reads/writes `$SKELM_APPROVALS_CONFIG` (default `~/.skelm/approvals.config.json`), with file mode `0600`. The gateway re-reads the policy on `skelm gateway reload`. Routing the writes through the gateway HTTP surface (so policy changes land in the audit chain) remains a follow-up.
- **Examples** — `incident-response`, `approval-workflow`, and `sprint-planning` pipelines; `dashboard-demo` static HTML exercising the new dashboard / workflow / batch / config routes.
- **`@skelm/agent` qwen36 validation** — script plus integration test covering tools, skills, and MCP against a local qwen36 model.

### Changed
- **`@skelm/integrations` rewritten on `@skelm/integration-sdk`** — `GitHubIntegration` and `SlackIntegration` now use `defineIntegration()`; runtime behaviour preserved.
- **System-prompt builder lives in `@skelm/core`** — shared between `@skelm/agent` and the Anthropic backend.
- **Examples cleanup** — `matrix-coding-agent` example removed; assorted PR #83 review fixes applied to the remaining examples.
- **Branding** — skelm wordmark removed from the logo; author byline removed from `README.md` footer.

### Fixed
- **`@skelm/agent`**: actionable denial messages for `http_fetch` and `load_skill` (previously surfaced as generic permission errors).
- **`mcp.tool.invoked` / `mcp.tool.completed` audit events** for the native-agent `McpHost` (#107) — closes an audit-blind spot when agents dispatch MCP tools through the in-process host.
- **`@skelm/codex`**: default-deny synthesis, `systemPromptMode` wiring, web-search bypass, request timeout, and streaming-delta handling (#106 review).
- **Gateway `/v1/config`** no longer 500s when live backend instances are present; **`/v1/workflows`** lists workflows discovered via glob.
- **Core nesting-safety gaps** closed in `forEach`, `parallel`, `loop`, and `wait` (#102 follow-up).
- **`@skelm/agent` system-prompt** — PR #104 review feedback applied.
- **Docs** — double-base on the `openapi.yaml` download link fixed.

### Security
- **`@skelm/codex` default-deny synthesis** — Codex backend policy now denies by omission rather than inheriting Codex SDK defaults; web-search bypass closed in the same pass.

### Docs
- **Accuracy sweep across reference, guides, recipes, and example READMEs**; full root markdown content relocated into `docs/` with section indexes; `.github/` carries equivalent content.
- **Generated API reference** + promoted skill references under `docs/reference/`.
- **Backends page** fleshes out `@skelm/agent` and leads the backend table.
- **Gateway docs** for `/v1/dashboard`, `/v1/workflows`, `/v1/batch`, `/v1/config`.
- **Site polish** — dead links fixed, OpenAPI rendered, orphan guard added, landing and quickstart pages tightened.
- **System-prompt builder** documented along with override modes and `AGENTS.md` extension.
- **Source-tree links** converted from `../../` to absolute `github.com` URLs.

### CI
- **`pnpm check` regression firewall** (#108) — lint + baseline + workflow-archive test now gate `pnpm check`; CI stops letting `pnpm check` regress silently.
- **Docs build** runs after package builds.
- **Publish pipeline** — `@skelm/codex`, `@skelm/agent`, and `@skelm/vercel-ai` included in publish order / gh-packages publish; rescope map updated.

## [0.3.8] - 2026-05-13

### Added
- **`@skelm/agent` first-party agent backend** (#85) — native skelm agent backend with enforced permission policy. Includes an `exec` built-in tool gated by `allowedExecutables`, `fsRead`/`fsWrite` allowlist roots honoured in `normalizePath` (#89), and MCP tool advertisement + dispatch to the model (#90). Now published from this monorepo at version 0.3.8.
- **`@skelm/vercel-ai` backend** (#74) — Vercel AI SDK backend with `onPartial` streaming and a `generateObject` / `Output.object` schema path (#81, F006).
- **`invoke()` step** — call any registered pipeline by id from inside another workflow. The runner resolves the target through a `pipelineRegistry` callback (in-process tests supply their own; the gateway wires one automatically from `Gateway.registries.workflows` with a fallback scan that matches by `pipeline.id` when the registry id lookup misses). Throws `InvokePipelineNotFoundError` when the id is unknown. Nested runs inherit the parent's store, permissions, secret resolver, audit writer, and egress-proxy wiring. (#84)
- **`ctx.secrets` in `code()` / `llm()` / `agent()` callbacks** (#84) — steps that declare `secrets: [...]` now expose a `get(name)` accessor inside `run`, `prompt`, `system`, and `mcp` callbacks. Names are resolved through the `SecretResolver` and (when the step declares `permissions: { allowedSecrets }`) gated by `TrustEnforcer.canAccessSecret` before the callback runs. Missing names fail with `MissingSecretError`; denied names fail with `PermissionDeniedError`. For `agent()` steps the values are also forwarded to the backend as `AgentRequest.secrets` for tool/exec env-var injection.
- **`step.partial` streaming events** (#84) — backends that opt into streaming (`vercel-ai`, `@skelm/pi` SDK, `@skelm/opencode`) emit incremental output through `onPartial(delta)`; the runner publishes each chunk as a `step.partial` event on the bus, observable via `skelm run … --events json`.
- **CLI `SecretResolver` wiring** — `skelm run` now instantiates `FileSecretResolver` (driver `'file'`, honouring `SKELM_STATE_DIR` / `~/.skelm/secrets.json`) or `EnvSecretResolver` based on `skelm.config.ts` and passes it to `runPipeline()`. Previously the CLI path always failed agent/llm/code steps that declared `secrets: [...]` with "no SecretResolver is configured".
- **CLI gateway `loadWorkflow`** — `skelm gateway start` now passes its tsImport-based workflow loader to the `Gateway` constructor as well as the trigger dispatcher. Without this, `POST /pipelines/:id/run` returned 501 and invoke() targets could not be resolved over HTTP.
- **`skelm approvals` CLI** (#55) — config command for managing approval policy and approver lists.
- **Gateway embedded CONNECT proxy** (#76) — real `networkEgress` enforcement at the network layer; per-step proxy env plumbed through the runner; pi-sdk and pi-rpc backends use it for egress.
- **Telegram integration + example** (#71, #72) — `TelegramIntegration` and a gateway-hosted Telegram bot example.

### Changed
- **Homepage URLs point to `https://skelm.dev/`** — all 12 published packages now point at the docs site (previously `scottgl9.github.io/skelm/`).
- **Gateway default port standardized to `14738`** (#73).
- **Internal refactors, no behaviour change** — runner step handlers + leaf helpers extracted from `runner.ts` (#86); gateway lifecycle interfaces moved to `gateway-types.ts`; `@skelm/agent` `backend.ts` split into `http-client` + `tools` + `prompt` modules; shared backend helpers extracted into `@skelm/core`.
- **Co-located `core` tests moved under `test/`** (#87).
- **Changesets workflow removed** — `.changeset/` workflow and `pnpm guards:changeset` retired; CHANGELOG.md is now the single source for release notes.
- **Docs accuracy pass** (#68, #69, #70) — reference, guides, recipes, and example READMEs updated to match current APIs; VitePress build no longer breaks on bare angle-bracket tokens.

### Fixed
- **`step.timeoutMs` enforced on `agent()` steps** (#88) — the per-step deadline now actually fires and aborts the backend.
- **`permission.denied` audit event for `BackendCapabilityError`** (#94) — capability-check denials are now auditable instead of silently failing.
- **MCP permission denials + tool dispatch written to audit log** (#91) — closes a previous audit-blind spot for MCP tools.
- **opencode**: forward MCP servers, answer permission asks, kill orphaned child processes on shutdown (#93).
- **`pi-sdk` `stopReason: 'error' | 'aborted'`** promoted to a real failure (#79, F007) instead of being treated as success.
- **`pi-sdk` fail-closed when `networkEgress !== 'allow'`** — drops `bash` (and other network-capable tools) from the allowlist; the only outbound path Pi has.
- **`vercel-ai` schema path** (#81, F006) — uses `generateObject` / `Output.object` for `outputSchema`, not best-effort JSON parsing.
- **Gateway discovery URL** written correctly on start (#78, F004).
- **`schedule --input` persisted** and used as the default fire payload (#77, F008).
- **Gateway egress audit hardening** (#82, F010) — records source, token presence, and a deny counter; well-formed-but-unknown tokens are treated as unknown rather than passed through.

### Security
- **Real `networkEgress` enforcement** via the gateway's embedded CONNECT proxy (#76) — `'deny'` and `'restricted'` are now enforced at the network layer, not just by tool allowlisting.
- **Egress audit captures source + token presence + deny counter** (#82, F010) — closes a blind spot when well-formed but unknown tokens were silently accepted.
- **MCP permission denials are now audited** (#91) — denying a tool call is observable in the audit log; previously only allowed dispatches were recorded.

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
- **skelm Agent Skill** — published at `skill/skelm` for use as a Claude Code skill.
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
