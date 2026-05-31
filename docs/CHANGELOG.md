# Changelog

All notable changes to skelm are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the project is pre-1.0, minor versions may include breaking changes; breaking changes are always called out explicitly.

## [Unreleased]

## [0.4.5] - 2026-05-31

### Breaking Changes

- **Renamed `llm()` step builder → `infer()`; renamed backend SPI `infer()` → `inference()`.** Step authors call `infer({...})`; backend authors implement `async inference(req, ctx)`. The rename also touches the public type (`LlmStep` → `InferStep`), runtime helpers (`executeLlmStep`/`runLlmStep` → `executeInferStep`/`runInferStep`), the step-kind discriminator (`'llm'` → `'infer'`), the config routing key (`backends.llm` → `backends.infer`), the SPI request/response types (`InferRequest`/`InferResponse` → `InferenceRequest`/`InferenceResponse`), and the capability/routing strings (`'infer'` → `'inference'`). No deprecation shim. Migration: `import { llm }` → `import { infer }`; `llm({...})` → `infer({...})`.

- **`skelm list` now shows the running view by default** — persistent workflows, armed triggers, session counts, and in-flight runs (`GET /v1/active`). The previous discovery view moves behind `skelm list --all`. Scripts that parsed bare `skelm list` for discovered workflows must switch.

- **"Persistent agent" reframed as "persistent workflow"** in the public surface — the builder is `persistentWorkflow()` and the gateway/CLI verbs follow.

### Added

- **Persistent workflows (`persistentWorkflow()`).** A triggered workflow whose conversation outlives any single trigger fire. Each fire runs optional preamble steps (`code()`, `infer()`, control flow) fresh, then always ends in one bounded, gateway-enforced, audited terminal agent turn against a durable per-session conversation (keyed by an `agent.sessionKey` you supply, e.g. a Telegram `chatId`). Sessions survive gateway restarts with no resident process; triggers drive fires. The terminal turn's `agent.permissions` apply only to that turn — preamble steps stay default-deny even under an unrestricted grant. Sessions are protected by a CAS-based advisory lock with stale-lock recovery, and distinct `sessionKey`s run concurrently. See [`docs/concepts/persistent-workflows.md`](./concepts/persistent-workflows.md).

- **First-class agentmemory integration (`@skelm/agentmemory`).** New workspace package: a typed REST client and gateway-wired `AgentmemoryHandle` for the [agentmemory](https://github.com/rohitg00/agentmemory) memory microservice — direct integration, no MCP shim. Enable via `agentmemory: { enabled, url, secretName, timeoutMs }` in `skelm.config.ts`. Adds the default-deny `agentmemory` permission dimension on `AgentPermissions` with per-op flags (`allowObserve`/`Search`/`Session`/`Context`/`Save`/`Recall`/`Graph`); all ops audit through the chain writer. `BackendContext.agentmemory` is wired into `@skelm/agent` (per-tool observe + final-answer `task_completed` + recall under a `<memory>` block), `@skelm/codex`, `@skelm/opencode`, `@skelm/vercel-ai`, and `@skelm/pi` (per-turn observe + system-prompt recall). See [`docs/guides/agentmemory.md`](./guides/agentmemory.md) and `examples/agentmemory/`.

- **`delegation` permission dimension + `delegate` built-in tool.** Agents can spawn bounded child runs whose permissions are intersected against the caller's delegation ceiling. New `runDelegation` helper threads ceiling, stack, and depth through the runtime and enforces the allowlist; the dimension survives parallel & forEach branches. See `docs/concepts/delegation.md` and `examples/agent-delegation/`.

- **Operator-gated unrestricted permission bypass.** A two-keyed escape hatch from default-deny: the author declares `permissions.requestUnrestricted: true` (inert on its own); the operator allowlists the id in `defaults.unrestrictedGrants` (or env `SKELM_UNRESTRICTED_WORKFLOWS`). Only when both agree does `TrustEnforcer` short-circuit every dimension. Each bypassed turn emits a `permission.bypassed` audit event, fanned out per dimension granted. A pipeline can never self-escalate. See [`docs/concepts/permissions.md`](./concepts/permissions.md#the-unrestricted-bypass-freewheeling-agents).

- **`@skelm/agent` bundled with the CLI.** Installing `skelm` now pulls the first-party agent backend alongside `codex`, `opencode`, and `pi`. Reference it under the `skelm-agent` id (the bare `agent` key is reserved): `backends: { 'skelm-agent': { baseUrl, apiKey, ... }, agent: 'skelm-agent' }`.

- **`skelm run <dir>` activates triggered/persistent projects on the gateway.** When a directory declares `triggerSources` or its entrypoint is a `persistentWorkflow()`, `skelm run` hands the directory to the gateway (`POST /v1/projects/activate`), which imports the config in-process, registers triggers/backends/workflow, merges `unrestrictedGrants` / `agentmemory`, and takes ownership. Re-running is an idempotent refresh. Path-gated against the gateway's `projectRoot` / `allowedRegistrationDirs` before any code runs. One-shot pipelines unchanged.

- **`skelm stop <id>`** deactivates a workflow on the gateway — unregisters triggers, drops the registration, keeps persisted sessions for re-activation. `--cancel-inflight` also cancels running turns. Distinct from `skelm gateway stop` and `skelm schedule stop <trigger-id>`.

- **CLI-hosted TUI (`createRemoteTriggerSource`).** The gateway side is headless; `skelm run` hosts the project's terminal frontend in the CLI process and streams each turn over the run SSE (`step.partial` → `renderPartial`, final → `render`) via `POST /v1/tui/:sourceId/submit`. Lets the gateway run as a daemon while you chat from your own terminal; the embedded `TuiIntegration.createTriggerSource({ frontend })` form still works.

- **Matrix chat trigger/response integration** — drive a persistent workflow from a Matrix room. See the Matrix recipe under `docs/recipes/`.

- **Telegram who-can-talk allowlist.** `telegram.createTriggerSource({ allowedChatIds, allowedUsers })` drops inbound updates from non-allowlisted chats/senders before they fire a workflow — the recommended inbound gate for a privileged or unrestricted agent.

- **`examples/telegram-assistant/`** — persistent-workflow + agentmemory + unrestricted Telegram assistant behind a who-can-talk allowlist. **`examples/tui-assistant/`** — the same pattern over a local TUI in the minimal no-preamble shape.

- **`@skelm/otel` wired into the gateway** for OpenTelemetry trace export. The workspace reaper also sweeps stale ephemeral workspaces on gateway start.

- **`Run.status='waiting'` persisted on `wait()`** so paused runs survive a gateway restart and resume via the existing `/runs/:id/resume` path.

- **Idempotent backend registry, mutable-once backends, shared `CONFIG_FILENAMES`.** Re-activation no longer fails on duplicate registration; backend definitions can be replaced once.

- **Typed `BackendAuthenticationError` / `BackendRateLimitError` / `BackendTimeoutError`** consolidated into `@skelm/core/backend`. The backend-contract suite gained per-dimension `adversarialCases`, exercising default-deny against every claimed capability.

- **New gateway endpoints:** `POST /v1/projects/activate`, `GET /v1/active`, `POST /v1/workflows/:id/deactivate`, `POST /v1/tui/:sourceId/submit`.

### Fixed

- **`runWithMemoryTurns()` extracted** in `@skelm/core` and four backend agent loops rewired onto it (`@skelm/agent`, `@skelm/codex`, `@skelm/opencode`, `@skelm/vercel-ai`, `@skelm/pi`).
- **Backend-capability fail-close scoped to author-declared permissions** — a backend missing a capability the author never asked for no longer fails the step.
- **Approval `resolve`/`timeout`/`cancel` chained onto audit-write completion** so the audit chain cannot lose an approval decision under shutdown races.
- **Queue-driver `onEvent` honored and forwarded on the non-persistent dispatch path** so queue drivers receive live run events on every code path.
- **Project-default permissions applied to gateway-run pipelines** (parity with locally-dispatched runs).
- **Sparse crons re-checked at the horizon** so leap-day schedules fire instead of being skipped.
- **Malformed interval `every` rejected** with a typed error instead of thrown during trigger discovery (which previously crashed the whole config import).
- **`createEmptyPolicy()` removed** from `@skelm/opencode` (use `resolvePermissions(undefined, undefined)`); dead permission-mapper exports dropped from `@skelm/codex` / `@skelm/opencode` public APIs.
- **`research-specialist` example tolerates string or `{question}` input** (regression from input-shape tightening).

### Security

- **`fsWrite` enforced on the destination** of MCP `move` / `copy` / `rename`. The destination path was previously unchecked.
- **`fsRead` / `fsWrite` enforced on MCP `read_text_file` / `read_media_file`.**
- **Secrets redacted inside array log fields.** Previous redaction only walked object values.
- **Interval/poll `everyMs` validated** to prevent a `setInterval` tight-loop DoS from a malformed trigger config.
- **At/cron triggers armed with a chunked timer** to prevent `setTimeout` overflow-clamp on far-future schedules.
- **Delegation allowlist enforced inside `runDelegation`** and ceiling/guards preserved across parallel & forEach branches.
- **Persistent-workflow session locks recover from stale state** so a crashed turn does not park a session forever.

### Tests

- Validation-fail sweep for the runs / schedules / projects routes.
- Live qwen36 coverage for `agentDef` system-prompt injection; temp-dir cleanup in the suite.
- `pickFreePort` TOCTOU race + `httpProxyPort` sweep cleanup to de-flake gateway boot tests under parallel `pnpm test`.

### Docs

- `agentDef` (AGENTS.md/SOUL.md) loading + persistent-workflow system-prompt fields documented.
- Run/activate flow reconciled across guides, recipes, and examples.
- Dropped Gemini as a documented ACP option; fixed the Claude ACP example.
- Matrix-persistent-agent recipe dead-link repair.

## [0.4.4] - 2026-05-26

### Breaking Changes

- **The CLI now requires a running gateway for every non-exempt command.** `skelm run`, `list`, `describe`, `history`, `audit`, `workspace`, and `secrets` dispatch to the gateway over HTTP instead of executing in-process. The CLI no longer constructs its own `Runner`, `EventBus`, `SqliteRunStore`, `WorkspaceManager`, `ChainAuditWriter`, `FileSecretResolver`, or skill registry; the gateway is the single execution surface and trust boundary.

  **Exempt commands** that still work with no gateway running: `help`, `version`, all `gateway *` subcommands (start/stop/status/install/etc.), `init`, and `validate`.

  **Auto-start.** When a non-exempt command runs with no gateway live, the CLI auto-starts one:
    - If the platform's service manager has the unit/plist installed (systemd on linux, launchd on macOS) the CLI delegates to it (`systemctl --user start skelm-gateway` / `launchctl kickstart gui/<uid>/com.skelm.gateway`).
    - Otherwise the CLI spawns `skelm gateway start` detached in the background and prints a one-time hint suggesting `skelm gateway install --systemd` (linux) or `skelm gateway install --launchd` (macOS) for a supervised service.
    - Set `SKELM_NO_AUTOSTART=1` to opt out (the CLI then exits non-zero with an actionable message). In CI auto-spawn is refused unless `SKELM_AUTOSTART_IN_CI=1`.

  **Migration.** Most users see no change beyond a one-time `skelm gateway install --systemd` (or `--launchd`) on first run. If you previously relied on `skelm run` writing audit entries to a per-cwd `audit.jsonl`, those now live under the gateway's `$SKELM_STATE_DIR/audit.jsonl` (default `~/.skelm/audit.jsonl`). Same for `secrets.json`. Run-history and workspaces likewise centralize under the gateway's state dir.

  **New gateway HTTP endpoints powering the dispatch:**
    - `POST /pipelines/run-file`, `POST /pipelines/start-file`, `POST /pipelines/describe-file` — ad-hoc execution / description of a workflow file by absolute path
    - `GET /audit`, `GET /audit/verify` — chain reader
    - `GET /workspaces`, `GET /workspaces/:wf/:name`, `DELETE /workspaces/:wf/:name`
    - `GET /secrets` (names only), `GET /secrets/:name` (existence check: `{name, set: true}`), `PUT/DELETE /secrets/:name`. Plaintext deliberately never leaves the gateway process over HTTP — workflows resolve values in-process via the gateway-side SecretResolver. `skelm secrets get NAME` reports `NAME: set` / `NAME: not set` rather than the value.

  A new structural guard (`pnpm guards` → `scripts/guards/cli-no-core-runtime.ts`) keeps the CLI from reintroducing in-process runtime work.

  **Interactive `wait()` resume restored.** `skelm run` now subscribes live to `/runs/:runId/stream` over SSE, prompts on `/dev/tty` (or stderr/stdin fallback) when the gateway emits a `run.waiting` event, and POSTs to `/runs/:runId/resume`. The gateway-side stream handler is replay-then-tail with explicit `res.flushHeaders()`, so even a sub-second run is delivered in full when the CLI subscribes after completion. Non-interactive invocations (CI, piped empty stdin) still surface `EXIT.RUN_PAUSED = 8` together with the `curl` recipe for out-of-band resume.

- **`Run.waiting` snapshot on the Run record.** While a run is parked at a `wait()` step, the gateway persists a serializable `RunWaiting` snapshot (`stepId`, optional `message`, optional `timeoutMs`, `since`) on the Run. HTTP clients can detect pause from a single `GET /runs/:id`. Cleared on `run.resumed`.

- **`sessionId?: string` promoted to `AgentRequest`.** The structural-typing cast inside the `@skelm/codex` backend is gone; backends can read the session id off the request directly.

### Added

- **Ad-hoc start by path on `POST /runs`.** Submit `{ path: "/abs/workflow.mts", input?: ... }` to start a run without pre-registering the workflow; the `input` alias is also accepted on resume.
- **Absolute-path trigger dispatch.** Scheduler/trigger entries that reference an on-disk workflow path now start runs through the gateway and honor `SKELM_GATEWAY_URL` for the dispatch target.
- **`skelm schedule add` accepts a workflow file path** in addition to a registered pipeline id.
- **Egress proxy wiring on HTTP run paths.** When a gateway is configured with an egress proxy, ad-hoc HTTP-launched runs now flow through it (previously only locally-dispatched runs did).
- **Skelm builder workflow** with selectable backend (codex, pi-sdk verified against local qwen36); permissions on the builder are self-contained so it can be cloned without pulling in repo-wide defaults.
- **Resolve directories to a config entrypoint in `skelm run`.** Passing a directory now picks up its `skelm.config.{mts,ts}` / default workflow entry instead of erroring.

### Fixed

- **Gateway WorkspaceManager scoped to the gateway state dir** so workspaces created during a run are visible to subsequent `GET /workspaces` queries.
- **Tool-class dimensions named in the unsupported-backend refusal**, so the error tells you which class of tool the backend lacks instead of an opaque enum value.
- **Embedded/ad-hoc gateway discovery isolated** so `gateway stop()` can never delete a persistent installation's `gateway.json`.
- **Ad-hoc gateway port isolated per state dir** to prevent port collisions and cross-state data access when multiple CLIs run in parallel.
- **Secrets redacted in the top-level env map** returned by `GET /v1/config`.
- **Out-of-tree workflow resolution.** `skelm run` now searches `realpath(argv[1])` and `cwd` so workflows that live outside the package's node_modules tree resolve correctly (#225); the resolver also picks up `@skelm/*` packages from those locations (`53f0cea`).
- **`BackendCapabilityError` passthrough** in `@skelm/vercel-ai` so the typed error reaches the CLI instead of being wrapped in a generic failure (#224).
- **Typed `BackendError` end-to-end** across CLI, gateway, and `@skelm/agent`, with assorted gateway lifecycle fixes.
- **`canExec` basename-bypass closed** in `@skelm/core` — the exec policy no longer accepts a permitted basename when invoked via a different absolute path. (Security fix.)
- **Gateway starts out-of-box without `OPENAI_API_KEY`** set in the environment.
- **`gateway foreground` SIGTERM exits 0**, and the `gateway install --systemd` path was hardened.
- **`run` step-error output line surfaces the typed error class** so callers can switch on `error.code` without parsing strings.
- **`ctx.threads` deduplicates** identical adjacent messages; `SKELM_STATE_DIR` is honored by the CLI run store path.
- **Built-in backends receive secret resolvers** threaded from the CLI, matching the contract gateway-hosted backends already followed.
- **Subcommand help returns ok**, so `skelm <cmd> --help` no longer exits non-zero.

### Documentation

- Added an automated-testing section pointing to the `skelm-self-test` harness.
- Documented the CLI-as-gateway-interface refactor across the relevant guides.

### Tests

- Bulk-converted gateway boot sites to `bootGatewayWithRetry`; un-skipped the interactive `wait()`/resume test; ported the flaky `overlap` and workspace tests to the retry harness.

## [0.4.3] - 2026-05-22

### Breaking Changes

- **Minimum Node version is now 22.18** (was 20). Node 22.18+ ships unflagged-stable native TypeScript type stripping, which skelm now relies on instead of the `tsx` runtime register hook.
- **`tsx` removed.** Workflow and config modules now load via Node's native dynamic `import()`. No `--import tsx/esm`, no `tsImport`, no `?namespace=` query-string fingerprint.
- **Pipeline files are canonicalized to `.mts`.** The `skelm init` scaffold now writes `workflows/hello.workflow.mts`; default globs accept `workflows/**/*.workflow.{mts,ts}` and `workflows/**/*.pipeline.{mts,ts}`. Existing `.workflow.ts` / `.pipeline.ts` files continue to work in v0.4.3 — the `.ts` extension will be removed in v1.0 once `.mts` is muscle-memory.

Why: a fresh `npm init -y` defaults `package.json` to `"type":"commonjs"`. Combined with tsx's CJS register path appending `?namespace=<timestamp>` to `file://` URLs, this hit the Node 25 ESM resolver tightening and crashed the documented quickstart (`ERR_MODULE_NOT_FOUND`, [#175], [#176], [finding-132]). Canonicalizing to `.mts` makes the user's `package.json` `"type"` field irrelevant for skelm — `.mts` is always ESM.

Migration:

```bash
# Inside your project, after upgrading skelm to 0.4.3:
find workflows -name '*.workflow.ts' -exec sh -c 'mv "$1" "${1%.ts}.mts"' _ {} \;
find workflows -name '*.pipeline.ts' -exec sh -c 'mv "$1" "${1%.ts}.mts"' _ {} \;
```

If you prefer to keep `.ts`, add `"type": "module"` to your `package.json`.

**Two import-specifier gotchas in pipeline source.** Node's native ESM resolver is strict about relative-import specifiers — tsx was lenient about both:

1. **Extensionless imports** — `import { x } from './helpers'` no longer resolves. Add the extension: `./helpers.ts` (or `.mts`). Catch them with:

   ```bash
   grep -rnE "from '(\.\.?/[^']+)'$" workflows | grep -vE "\.(mts|ts|mjs|js|json)'"
   ```

2. **NodeNext `.js`-from-TS imports in uncompiled source** — `import { x } from './helpers.js'` (the conventional NodeNext spelling that TypeScript rewrites at compile time) breaks under native strip because pipeline files are loaded as `.ts` source, not compiled. The `.js` file doesn't exist on disk. Rewrite to the actual on-disk extension: `./helpers.ts`. Catch them with:

   ```bash
   grep -rnE "from '\.\.?/[^']+\.js'" workflows
   ```

   This only matters for files loaded directly by skelm (your `*.workflow.mts`, `*.pipeline.mts`, and helpers they pull in). Code you ship through `tsc → dist/*.js` is unaffected.

[#175]: https://github.com/scottgl9/skelm/issues/175
[#176]: https://github.com/scottgl9/skelm/issues/176
[finding-132]: https://github.com/scottgl9/skelm-test-plan/blob/main/results/finding-132-fresh-install-namespace-query-breaks-esm-on-node25.md

### Added

- **`when` predicate for conditional steps** — `when: (ctx) => boolean` on any step skips the step and emits `step.skipped` when the predicate returns false; no special handling needed in the surrounding branch.
- **`git-repo` workspace mode** — `workspace: { mode: 'git-repo', url, ref, auth }` clones a repository into a per-run temp dir and sets `ctx.workspaceDir`; supports SSH and token auth.
- **`ctx.threads` conversation helper** — typed multi-turn conversation manager available inside `agent()` and `llm()` steps; carries history across tool invocations without manual message array management.
- **`ctx.artifacts` binary artifact store** — `ctx.artifacts.write(name, buffer, mimeType)` persists binary run artifacts (screenshots, evidence, reports); `artifacts.read(ref)` retrieves them; each write emits an `artifact.created` audit event.
- **Multimodal image content** — `llm()` and `agent()` steps now accept `{ type: 'image', … }` parts in prompt messages. All first-party backends (`@skelm/agent`, `@skelm/vercel-ai`, `@skelm/codex`, `@skelm/pi`, `@skelm/opencode`, Anthropic, OpenAI) handle image content; `@skelm/vercel-ai` enforces a `visionModels` per-model allowlist.
- **`@skelm/agent` model registry, session lifecycle, and compaction** — `ModelRegistry` maps model ids to capabilities; `AgentSession` manages context-window lifecycle; compaction trims conversation history when the context budget is approached while honouring `preserveSystem`.
- **Event-source triggers** — `eventSource({ websocket | sse | rss | custom })` declares a long-poll or streaming trigger; the gateway manages reconnect and backpressure.
- **File-watch trigger** — `fileWatch({ glob, events })` fires a pipeline run on matching filesystem changes; single-file paths are supported without path doubling.
- **Webhook providers** — `webhookProvider: 'slack'` (Slack signing secret validation) and `webhookProvider: 'ms-graph'` (Microsoft Graph `clientState` enforcement) on `webhook()` triggers.
- **GitHub PR trigger** — `githubPr({ repo, events })` primitive that fires on pull-request lifecycle events via the real GitHub REST API.
- **Cron timezone support** — `cron({ expr, tz })` accepts an IANA timezone identifier; fires are computed in the declared zone.
- **Duration strings for interval triggers** — `interval({ every: '5m' | '2h30m' | … })` accepts human-readable duration strings (max 30 days); `parseDuration` is exported from `@skelm/core`.
- **Pre-dispatch webhook deduplication** — the gateway tracks delivery ids per webhook trigger; duplicate deliveries within the replay window are rejected before dispatch.
- **`skelm schedule add --tz` and `--every`** — new flags wire timezone and duration-string interval directly from the CLI.
- **Gateway declared-trigger reconciliation on reload** — `skelm gateway reload` (SIGHUP) now diffs the running trigger set against `skelm.config.ts` and registers new triggers, updates changed ones, and sweeps orphans.
- **`/healthz` and `/readyz` endpoints** — `/healthz` returns 200 while the process is alive; `/readyz` returns 200 only when `state === 'running'` (503 during startup/shutdown); `/health` retained as a backward-compatible alias.

### Changed

- **`SecretResolver` wired into OpenAI and Anthropic backends** — backends now resolve `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` through the gateway's `SecretResolver` (auditable, swappable) before falling back to `process.env`. Pass `secretResolver` in backend options to enable.
- **Typed errors replace bare `Error` throws in backends** — four new error classes in `@skelm/core/backend`: `BackendConfigError`, `BackendUpstreamError`, `BackendSessionError`, `AgentMaxTurnsError`. All 25 bare `new Error(…)` throws in `@skelm/agent`, `@skelm/codex`, and `@skelm/opencode` are replaced.
- **Circular imports eliminated** — `@skelm/core` reduced from 6 cycles to 2 (leaf types hoisted to `types-base.ts`, `mcp/types.ts`, `artifact-types.ts`); `@skelm/cli` reduced from 9 cycles to 0 (`MainIO`/`MainResult` hoisted to `internal/io.ts`).
- **`@skelm/pi` migrated to `@earendil-works/pi-coding-agent`** — updated SDK dependency; env-var resolution for `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` is now honoured.
- **`MemoryRunStore` documents dev/test scope** — capped at 10k runs / 50k events / 100k audit entries by default; `listRuns` hot path collapsed from five chained `.filter()` calls to a single pass.
- **`ChainAuditWriter` serializes writes and fsyncs per append** — concurrent callers no longer interleave partial entries; the file is synced before the write resolves.

### Fixed

- **Scheduler**: real cron expression parsing replaces stub; overlap policy (`skip` / `queue` / `replace`) is fully implemented; per-trigger state cleared on `unregister`; timer leak closed; orphaned runs when no executor is wired now fail the run explicitly instead of parking forever.
- **Coordinator drift and queue-drain race** — next cron tick is scheduled _before_ the current fire so cadence does not walk forward on slow pipelines; queue-drain holds `inflight=true` through the full drain, closing a microtask window that could allow concurrent fires.
- **Runner abort-listener leak** — `runPipeline` now unregisters its `abort` listener on every return path (success, validation failure, run failure), preventing listener accumulation on long-lived `AbortController` instances.
- **Approval gate fail-closed** — a step declaring an approval policy against a runtime with no `approvalGate` wired now fails with `ApprovalDeniedError` + `permission.denied` event instead of silently proceeding.
- **`exec` basename-bypass closed** — `canExec` now requires the exact path in the allowlist when the binary contains a path separator; bare names still resolve via `basename`; `tool.call` / `tool.result` / `permission.denied` audit events emitted on every exec.
- **Atomic `FileSecretResolver` writes** — `set`/`unset` are serialised per instance; writes go through tmp-file + fsync + rename so the file is always intact.
- **API boundary validation** — OpenAI and Anthropic responses are shape-checked before use; approvals policy JSON is validated on read; malformed inputs now produce typed errors with actionable messages instead of crashes or silent corruption.
- **Gateway shutdown bounded** — `Gateway.stop()` now races a 30 s overall timeout; stop-time failures (lockfile, port unbind, audit flush) are logged to stderr and trigger `exit(1)` so systemd sees the failure instead of silently swallowing it.
- **`/runs` and `/runs/:id/events` memory caps** — `GET /runs?limit=…` clamped to [1, 1000]; `/runs/:id/events` gets a default of 1000 and hard cap of 5000, preventing heap exhaustion from oversized queries.
- **Event bus indexed by `runId`** — `EventBus.subscribe(runId, …)` is O(1) instead of linear scan; SSE streams heartbeat every 15 s to prevent proxy timeouts.
- **Trigger queue depth capped** — `overlap='queue'` now enforces a hard cap (default 100); fires exceeding the cap return `'skipped'` and increment a dropped counter rather than growing the queue unboundedly.
- **opencode URL parsing hardened** — server URL is parsed from stdout only, anchored to start-of-line, and restricted to loopback addresses; parse buffer capped at 64 KiB.
- **CLI ANSI stripping** — step ids, run error messages, and log entry text pass through `safeForTty` (backed by `util.stripVTControlCharacters`) before reaching stdout/stderr, preventing VT sequences from forging terminal output.
- **Default fetch timeouts** — CLI gateway-client and `githubFetch` now default to a 30 s `AbortSignal.timeout`; callers that supply their own signal retain their existing behaviour.
- **`@skelm/agent` `preserveSystem` honoured in compaction** — `findCutPoint` no longer trims the system prompt block; `maxTokens` cap applied correctly to chat-completion calls.
- **`@skelm/pi` vision hint** — system prompt receives an image-capability hint when the request includes image content parts.
- **Gateway async event-source `start()` errors captured** — previously thrown into an unhandled rejection; now written to `lastError` on the trigger registration.
- **MS Graph webhook `clientState` enforced** — requests without a matching `clientState` are rejected 400; unenforced delivery was an integrity gap.
- **`gateway reload` concurrent serialization** — multiple simultaneous SIGHUP signals no longer race on config re-read.
- **`parseDuration` bounded to 30 days** — durations above the cap return a parse error instead of silently scheduling a multi-year interval.
- **File-watch single-file path** — the trigger no longer doubled the basename when a plain file path (not a glob) was provided.
- **`skelm gateway start` crash handlers** — uncaught-exception and unhandled-rejection handlers installed before startup; gateway crash no longer leaves a stale lockfile.
- **`better-sqlite3` postinstall allowlisted** — `chore(deps)!` pins an exact version and adds the native-build postinstall to the allowed-scripts list, unblocking CI on clean installs.
- **`@skelm/vercel-ai` rejects per-call `model` override against the bound `LanguageModel`** ([finding-133]). vercel-ai binds a `LanguageModel` at backend construction (e.g. `openai.chat('qwen35')`) and previously discarded any per-call `req.model`, silently running the bound model instead. `assertModelMatchesBound` now throws `BackendCapabilityError` with `capability='modelSelection'` when the step requests a model the backend cannot route to; the error message names both the bound id and the requested id and points operators to either registering a second backend instance or dropping the step's `model` field.

[finding-133]: https://github.com/scottgl9/skelm-test-plan/blob/main/results/finding-133-vision-model-mismatch-silent-text-completion.md

### Security

- **Constant-time secret comparisons** — gateway bearer-token check, webhook-secret check, and `GitHubTrigger` HMAC compare all replaced with `timingSafeStringEqual` (new export from `@skelm/core`); previous `!==` comparisons leaked timing.
- **GitHub trigger fail-closed on missing signature** — a secret-configured `githubPr`/`webhook` trigger that receives an unsigned delivery now rejects with 401 instead of accepting it.
- **Webhook HMAC required** — `webhook()` triggers with `secret` configured now require a valid HMAC signature _and_ enforce a 5-minute replay window; requests outside the window are rejected.
- **`exec` path-injection guard** — absolute paths in `ctx.exec` must be explicitly listed in `allowedExecutables`; basename matching only applies to bare command names, closing the `/tmp/evil/git` bypass.

### Tests

- Closed testing gaps H7–H13, H19–H24, H28–H33: coordinator drift/race, runner abort-listener leak, exec audit + path-injection, atomic secrets, API boundary validation, gateway shutdown, memory caps, ANSI stripping, URL parsing, all covered CLI exit codes, gateway auth sweep across all 16 route modules, approval fail-closed, wait/resume event ordering, and `@skelm/skelm` meta-package smoke tests.

### Docs

- **Triggers guide** — cron timezone, duration strings, file-watch, event-source, and webhook provider configuration documented under `docs/guides/triggers/`.
- **Quickstart** — run lifecycle and troubleshooting sections clarified.
- **AGENTS.md / CLAUDE.md** — merged into a single source; README scheduler scope corrected.

### Breaking Changes

- **`webhook()` triggers with `secret` now require HMAC + replay window** — requests without a valid `X-Hub-Signature-256` header (or outside the 5-minute window) are rejected. Update any webhook sender that was relying on the secret being advisory.
- **Scheduler no longer silently parks runs when no executor is wired** — pipelines fired by a trigger without a wired executor now fail the run explicitly (`RUN_FAILED`). Previously they disappeared with no event.
- **`better-sqlite3` pinned to exact version** — installs that previously resolved a wider range may need to run `pnpm install` to update the lockfile.

## [0.4.2] - 2026-05-18

### Added
- **`code({ module, export })` module refs and `ctx.exec` helper** — `code()` steps can now load their `run` function from an external `.ts`/`.js` file resolved against `pipeline.baseDir`; `loadTsModule` is exported from `@skelm/core` for imperative use. New `ctx.exec({ command | python | bash, args, cwd, env, stdin, timeoutMs, throwOnNonZero })` spawns external executables under `TrustEnforcer.canExec`, with default-deny when `permissions.allowedExecutables` is omitted. `python:` / `bash:` shortcuts resolve through `$SKELM_PYTHON` / `$SKELM_BASH`; the basename of the resolved binary is what the allowlist checks.
- **`code()` step `timeoutMs`** — `code()` builder accepts a per-step `timeoutMs`; the handler races `step.run` against the budget and fires `StepTimeoutError` even when the author ignores `ctx.signal`. Previously a runaway code step could block the gateway indefinitely.
- **Crash recovery for interrupted runs** — the gateway persists the `Run` record up-front (before the first step). On cold start, a recovery sweep finds runs left in `running` state and reconciles them.
- **Backpressure signal on slow run-store `appendEvent`** — the runner tracks in-flight append depth; crossing the saturation cap (256) emits `run.warning(code='store.saturated')` once, and `run.warning(code='store.recovered')` when the queue drains. No events are dropped; the signal is informational.
- **Approval lifecycle audit** — `SuspendApprovalGate` accepts an `AuditWriter` and emits `approval.requested` / `approval.resolved` / `approval.expired` / `approval.cancelled` entries. Wired by default to the gateway's `ChainAuditWriter` so approver, decision, and reason survive restart and are tamper-evident. Audit write failures are swallowed to keep the approval flow live.
- **`pnpm guards` dist-invariants check + `prepublishOnly` hooks** — `scripts/guards/dist-invariants.ts` reads a feature → expected-dist-substring manifest and fails if a built `dist/` is missing a feature its source advertises. Wired into `pnpm guards` / `pnpm check`, and into `prepublishOnly` for `@skelm/core`, `@skelm/cli`, and `@skelm/gateway` so stale tarballs are blocked even when `scripts/publish-npm.sh` is bypassed. Defense-in-depth against the v0.4.1 F038 stale-`dist/` publish.

### Changed
- **Typed errors for handler exhaustion paths** — `handlers.ts` no longer throws bare `new Error(...)` for unknown step kind, branch-no-match, and wait-without-handler. New internal `StepKindError`, `BranchExhaustionError`, and `WaitConfigError` (not re-exported on the public surface) keep `StepError` audit serialization keyed off `error.name` meaningful.

### Fixed
- **Workflow / skills glob walk no longer hangs on `$HOME`** (#127) — `walkGlob` previously scanned the entire `projectRoot` (= `process.cwd()`, which is `$HOME` under systemd-user services) looking for `workflows/**/*.workflow.ts`, and stalled in `buildRegistries()` before `startHttp()` could bind. The walk is now bounded to the static prefix of the pattern (`${rootDir}/workflows`, `${rootDir}/skills`). Patterns with no static prefix (`**/*.ts`) still walk from the root.
- **`ERR_PACKAGE_PATH_NOT_EXPORTED` on Node 22+** (#128) — every `@skelm/*` package's `exports` map now uses `default` instead of `import`, so both ESM `import` and CJS `require(esm)` resolution succeed. `loadWorkflowFromFile` (`@skelm/cli`) and `extractPipeline` (`@skelm/gateway`) also unwrap the `{ default: { default: <pipeline> } }` shape Node returns via `require(esm)`.
- **`require(esm)` double-default in the `skelm.config.ts` loader** — Node 22+ produces `{ default: { default: <config> } }` for `skelm.config.ts` under tsx's CJS path, so user `allowedExecutables` silently fell back to `DEFAULT_CONFIG` (empty allowlists). Both workflow and config loaders now route through the shared `pickExport` from `@skelm/core`.
- **`skelm schedule add` resolves the workflow path to the gateway registry id** (#143, F044) — the CLI used to submit the user-typed path verbatim as the trigger's `workflowId`, but the gateway stores workflows by their registry-relative id, so the dispatcher's `workflows.get()` returned `undefined` every fire and parked errors on the registration. `scheduleAdd` now fetches `GET /pipelines` and resolves the user input to the canonical registry id via (1) exact id, (2) absolute path, (3) unique suffix; ambiguous suffixes and unknown ids fail fast with the candidate list. Empty registries pass the user input through untouched.
- **PR #146 review — explicit stderr on `/pipelines` fetch failure, warn on empty registry** — `resolveWorkflowId` now writes `error: failed to reach gateway at <baseUrl>/pipelines` instead of a silent non-zero exit; empty-registry passthrough emits a `warn:` line.
- **Scheduler drains in-flight triggers on stop** — timers used to fire-and-forget `executeTrigger` calls, and `SIGTERM` cleared the timers but raced in-flight executions against process exit. `stop()` also short-circuited when `isRunning` was false (which it always is when triggers are registered without an explicit `start()`), so the timers themselves leaked. Each `executeTrigger` promise is now tracked; `stop()` clears timers then awaits `allSettled` with a 30s cap, unconditionally.
- **`skelm init .` over an `npm init`-created directory merges instead of erroring** (F036) — the previous gate only accepted a hardcoded `NPM_INIT_RESIDUE` set, so any stray dotfile, log, or editor swap broke the documented `npm init -y && npm i skelm && skelm init .` onboarding flow. Replaced with `isMergeableNpmInitDir`, which still refuses anything that looks like a skelm project (`skelm.config.{ts,js,mjs}` or `workflows/`) but tolerates incidental files alongside npm residue.
- **`skelm` meta-package transitively installs `@skelm/scheduler` and `@skelm/integration-sdk`** (F039, F040) — `npm i skelm` previously omitted both. Added to `packages/skelm/package.json` dependencies.
- **`skelm gateway start` exits cleanly on `EADDRINUSE` without leaking the lockfile** (F042) — listen-time errors used to fall through as an unhandled `'error'` event, crashing the process after the lockfile and discovery JSON were already on disk. The HTTP server now attaches an `'error'` listener before `.listen()` and reflects it into the `start()` promise; the lifecycle catch block calls `removeDiscovery()` + `releaseLockfile()` + `stopEgressProxy()` before resetting state, so a failed start is truly idempotent.
- **`SKELM_STATE_DIR` env override honored by every `skelm gateway` subcommand** (F043) — the CLI had a `defaultStateDir()` helper, but every `new Gateway(...)` callsite ignored it. Threaded `stateDir: defaultStateDir()` through `startGateway`, `statusGateway`, `stopGateway`, `signalGateway`, `detachGateway`, and the systemd start probe.

### Security
- **Path traversal closed at the fs allowlist boundary** — `TrustEnforcer.canRead` / `canWrite` compared raw strings, so a root of `/data` admitted `/data/../etc/passwd` via path-string prefix. Both the root and requested path are now normalized with `path.resolve` before the comparison, collapsing `..` / `.` segments first. New adversarial coverage for the traversal case and the existing sibling-root rejection (`/data-evil/`).

### Tests
- Coverage gaps closed in `@skelm/otel` (failure, cancel, tool, dispose event paths), `@skelm/integrations` (GitHub and Slack webhook event mappings), and `@skelm/agent` (MCP-tool permission enforcement in the native loop).

### Docs
- **`loadTsModule` cache contract** — JSDoc spells out that the module cache is process-global with no TTL/mtime check, and how to clear it from tests. Dropped the unused `fileUrlToPath` export; restored the `secrets?: string[]` line in skill/skelm/references that was inadvertently dropped from the `code()` signature block.
- **README** — `@skelm/integration-sdk` listed in the packages table.

## [0.4.1] - 2026-05-17

### Fixed
- **`skelm gateway install` produces a working systemd unit** — the v0.4.0 unit hardcoded `ExecStart=/usr/bin/env skelm gateway start --foreground`, but systemd-user services run with a minimal PATH (`/usr/local/bin:/usr/bin:/bin`) that does not include npm-global bins, nvm shims, or local `node_modules/.bin`. The unit crash-looped with `/usr/bin/env: 'skelm': No such file or directory` (status 127) on every install. The unit template now embeds absolute paths derived from `process.execPath` (node) and `process.argv[1]` (the running skelm bin), so the service starts regardless of how skelm was installed. A new `packages/cli/test/gateway-systemd-unit.test.ts` locks down the absolute-path invariant.

## [0.4.0] - 2026-05-16

### Added
- **`skelm gateway install`** — single-step install that writes the systemd user unit, runs `daemon-reload`, and `enable --now`s the service. Drops the previous `--systemd` flag requirement. Hints `loginctl enable-linger <user>` when lingering is off and warns on success if it remains disabled.
- **`skelm gateway uninstall`** — stops and disables the service before removing the unit file and reloading systemd.
- **`skelm gateway status` reachability probe** — probes the HTTP endpoint and reports a `reachable` field (`yes` / `no` text, included in `--json`); value is `unknown` / `null` when no URL is known.
- **README** — Key capabilities list now documents the `SKILL.md` system (reusable capability bundles, `allowedSkills` permission gating, auto-discovery from `skills/**/SKILL.md`).

### Changed
- **`skelm gateway start` is context-aware** — when the systemd unit is installed, delegates to `systemctl --user start` and exits; otherwise falls back to foreground and suggests `skelm gateway install`. `--foreground` forces foreground regardless.
- **`skelm gateway stop`** — delegates to `systemctl --user stop` when the unit is installed (keeps systemd in sync and prevents auto-restart); falls back to `SIGTERM` otherwise. Writes to stderr with a non-zero exit when the gateway is not running.

### Fixed
- **Docs: gateway reference** — `reachable` is documented as `unknown` (text) / `null` (JSON) when no URL is known, not omitted.
- **Docs: http-enrichment recipe** — `SKELM_TOKEN` set in shell env is not inherited by the systemd unit; the recipe now shows the `systemctl set-environment` + drop-in override pattern.

### Build
- **No more `.map` files in published tarballs** — `sourceMap` and `declarationMap` dropped from `agent`, `codex`, `integration-sdk`, `integrations`, `opencode`, `pi`, `vercel-ai`, and `scheduler` tsconfigs to match the `@skelm/core` baseline. Source maps referenced `src/` paths the tarballs don't ship, so they only bloated the package.

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

[Unreleased]: https://github.com/scottgl9/skelm/compare/v0.4.4...HEAD
[0.4.4]: https://github.com/scottgl9/skelm/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/scottgl9/skelm/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/scottgl9/skelm/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/scottgl9/skelm/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/scottgl9/skelm/compare/v0.3.9...v0.4.0
[0.3.9]: https://github.com/scottgl9/skelm/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/scottgl9/skelm/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/scottgl9/skelm/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/scottgl9/skelm/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/scottgl9/skelm/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/scottgl9/skelm/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/scottgl9/skelm/releases/tag/v0.3.3
