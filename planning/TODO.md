# TODO

Current main state:

- M1 is landed.
- The planned M2 feature slices are landed on `main` (`f2e1596`).
- Session-tracked implementation todos are all complete.
- GitHub Packages publishing infrastructure added (`.github/workflows/publish.yml`).
- **Gateway-centric refactor complete on `feat/gateway-centric`.** Phases 0–14 all landed: `@skelm/server` absorbed into `@skelm/gateway`; gateway lifecycle (lockfile, discovery, signals); FS-watched registries (workflows, skills, mcp, agents); trust-boundary seams (PermissionResolver, AuditWriter, SecretResolver, ApprovalGate); chain-hashed audit log + file secret driver + suspend approval gate; supervisors for MCP servers, coding agents (resident + ephemeral), and ACP sessions; trigger coordinator + dispatcher; runtime invokes the approval gate at agent step start; backends accept lazy URL/command providers from the supervisor; HTTP control surface (POST /gateway/{pause,resume,reload}, /runs/:id/{approve,deny}, /sessions, /triggers); approval queue persistence; gateway-owned SqliteRunStore; CLI `skelm gateway start|stop|reload|status|install|uninstall`; examples for the matrix-triggered single-agent shape and a deterministic + LLM + agent multi-step pipeline. **652/654 tests pass** (skill parser, registries, lifecycle, enforcement, audit, approvals, MCP supervisor, coding-agent supervisor, ACP sessions, trigger coordinator, dispatcher, HTTP control, e2e, CLI smoke). See planning/21-gateway-and-deployment.md.

What remains is the unfinished acceptance work for M2, then the M3+ roadmap.

## M2 follow-through

- [x] Add the **Telegram coding agent fixture (UC1)** with a mocked Telegram MCP flow, persistent workspace usage, and idempotent repeat-message handling.
  - Created: `packages/core/test/fixtures/telegram/`
  - Files: `mocked-telegram-mcp.ts`, `telegram-coding-agent.pipeline.ts`, `telegram-coding-agent.test.ts`
- [x] Add the **property-test coverage** called out in the roadmap for:
  - event ordering
  - `ctx.steps[id]` correctness across accepted step graphs
  - Created: `packages/core/src/property-tests.test.ts`

## M3 — finish v1

- [x] Create `@skelm/server` (absorbed into `@skelm/gateway/http` in the gateway-centric refactor).
- [x] Add the HTTP + SSE run surface from `planning/08-server-mode.md`.
- [x] Support sync runs, async runs, resume, and cancellation over HTTP.
- [x] Add `Idempotency-Key` handling for server runs.
- [x] Add server auth modes (`none` for loopback-only, `bearer`).
- [x] Reject insecure `skelm serve --host 0.0.0.0 --auth none` startup.
- [x] Add audit logging seam (Phase 4) + chain writer (Phase 5). Producer wiring at every permission denial / approval / secret access lands as a follow-up to Phase 11.
- [x] Add `skelm history --run <id> --events`.
- [x] Add `skelm audit query` (chain JSONL, with `--verify`).
- [x] Add `skelm secrets get/set/list` with a file driver.
- [x] Integrate approval flows via `SuspendApprovalGate` (Phase 6); `permissions.approval` + `wait()` glue lands when the runtime invokes the gate at step start.
- [ ] Add basic `skelm debug` breakpoints / pause-inspect support.
- [ ] Add `@skelm/metrics` for Prometheus `/metrics`.
- [ ] Cover the M3 acceptance cases from `planning/15-roadmap-and-milestones.md`.

## M4 — post-v1 / v1.x+

- [x] Add the long-running scheduler (`cron`, interval, webhook, poll, queue).
- [x] Add trigger dedupe / overlap policies.
- [x] Add `@skelm/integrations` with the initial curated set (GitHub, Slack, Jira, IMAP, Telegram).
- [ ] Add `skelm connect` for OAuth flows.
- [ ] Add the OpenAI-compatible HTTP surface (`/v1/chat/completions`, `/v1/responses`).
- [ ] Add `skelm acp serve` — expose pipelines as ACP agents.
- [x] **Agent Runtime Expansion:** Add `@skelm/opencode` backend with full permission enforcement.
- [x] **Agent Runtime Expansion:** Add `@skelm/pi` backend for Pi coding-agent.
- [ ] **Agent Runtime Expansion:** Research and add `@skelm/copilot-sdk` backend for GitHub Copilot with enhanced control.
- [ ] Add routing and failover wrapper backends (marktoflow parity).
- [ ] Add `skelm bundle` — single-file deployable artifact.
- [ ] Add a Postgres `RunStore`.
- [ ] Add Vault / cloud secret drivers.
- [ ] Add compaction / session pruning helpers for long-running agents.
- [ ] Cover the M4 acceptance cases from `planning/15-roadmap-and-milestones.md`.

## Infrastructure & DevOps

- [x] GitHub Packages publishing workflow (`.github/workflows/publish.yml`)
- [x] Automated version updates from release tags
- [x] CI/CD pipeline with build, typecheck, lint, test
- [ ] Add npm registry publishing (in addition to GitHub Packages)
- [ ] Add release notes automation
- [ ] Add package size tracking
- [ ] Add performance regression detection

## Suggested order

1. Finish the two M2 acceptance gaps.
2. Build M3 end-to-end; that is the remaining work required to cut v1.
3. Treat M4 as the first post-v1 expansion wave unless roadmap priorities change.
4. Infrastructure improvements can happen in parallel as needed.
