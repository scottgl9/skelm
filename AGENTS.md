# AGENTS.md

Guidance for AI coding assistants and human contributors working on **skelm** — a TypeScript-first framework for authoring, running, and operating agentic and deterministic pipelines.

This file is the single source of truth for agent guidance. `CLAUDE.md` is a symlink to this file so Claude Code, Codex, Cursor, Aider, and other agents read the same rules.

## What skelm is

A Node/TypeScript framework whose unit of work is a **pipeline** — a typed, inspectable orchestration that can be a single agent or a multi-step workflow with parallel branches, loops, and nested pipelines. Pipelines run from the CLI, are hosted by a long-running gateway service, and integrate with LLMs, agent runtimes, and tool servers under explicit, default-deny permissions.

## Tenets

When goals conflict, the higher tenet wins.

1. **Security.** Default-deny everywhere; agent permissions are part of the public API. A backend that cannot enforce a declared permission must fail at step start, not silently bypass.
2. **Maintenance.** Small core, narrow public surface, replaceable internals. Every package boundary exists to keep blast radius small.
3. **Robustness for long-running workflows.** Typed context end-to-end, explicit errors, deterministic event log, durable wait/resume. Failures observable; recovery explicit.

## Repo shape

```
skelm/
├── packages/
│   ├── core/             — runtime, types, builders, run store, MCP host
│   ├── cli/              — bin: skelm
│   ├── gateway/          — long-running service; embeds scheduler; owns poll, queue, file-watch, event-source triggers; trust boundary
│   ├── scheduler/        — cron / interval / webhook triggers
│   ├── skelm/            — meta-package; re-exports core + ships CLI
│   ├── agent/            — first-party native agent backend with built-in tools
│   ├── agentmemory/      — cross-session memory via the agentmemory server
│   ├── pi/               — Pi coding-agent backend
│   ├── opencode/         — Opencode coding-agent backend (native + ACP)
│   ├── codex/            — OpenAI Codex backend (@openai/codex-sdk)
│   ├── vercel-ai/        — Vercel AI SDK backend with streaming
│   ├── integrations/     — typed connectors (GitHub, Slack, Telegram, ms-graph, …)
│   ├── integration-sdk/  — authoring SDK for custom integrations
│   ├── metrics/          — Prometheus-format metrics
│   └── otel/             — OpenTelemetry tracing
├── examples/
├── scripts/guards/       — architectural-invariant checks
└── docs/
```

## Working with the codebase

- **Read before you write.** For any non-trivial change: the touched module's TSDoc, the package `README.md`, and one nearby test. Gateway / security / public-API changes also read the relevant page under `docs/`.
- **If you can't predict what will break, read more — don't start writing.** Uncertainty is signal to keep reading, not signal to ship and find out.
- **Prefer existing utilities.** Search the package before writing a new helper. When one almost fits, extend it rather than parallel-implementing.
- **No speculative work.** Don't add features, refactors, or abstractions beyond what the task requires. Three similar lines beat a premature abstraction.
- **No defensive scaffolding** for cases that can't happen. Trust internal code and framework guarantees; validate at system boundaries (user input, external APIs, plugin entries).
- **No comments unless the *why* is non-obvious** — a hidden constraint, subtle invariant, workaround. One short line max. Don't explain what the code does; don't reference the current task or fix.
- **Match indentation exactly** to the file you're editing. Two-space TS; tabs only where the existing file already uses tabs.
- **Never edit generated files** (`dist/`, `coverage/`, `.skelm/`).

## Implementation discipline

**Before every commit, run `pnpm check` and confirm it passes.** This is non-negotiable — not "when in doubt", not "for big changes", every commit. Documentation-only commits included; the docs-orphans guard lives in the same pipeline and has caught real breakage. If `pnpm check` is red, the work is not done.

Every feature, fix, or behavior change follows this loop:

1. **Build.** `pnpm build` succeeds — no TS errors, no escalated warnings.
2. **Update or write tests.** New behavior gets new tests; changed behavior gets existing tests updated.
3. **Run all gates.** `pnpm check` passes top to bottom (build → typecheck → lint → guards → test). `pnpm guards` runs default-deny-permissions, public-export-baseline, gateway-only-enforcement, docs-orphans, dist-invariants, cli-no-core-runtime, and backend-contract-exhaustive.
4. **Commit only when green.** A commit on a red tree is a defect.

If a failing test is verifiably pre-existing and unrelated to your change (same failure on `main`, environment-specific, etc.), call it out explicitly in the commit body or PR description rather than silently committing through. Don't normalize red trees.

**Big features land in small, green increments.** Focused change → `pnpm check` → validate the increment → commit → push → continue. Confirm cadence with the user before the first commit on a fresh feature. Don't pile up unpushed work.

All work lands on a branch and merges to `main` via PR; CI gates the merge. Locally, the rule is simpler: don't commit on a red tree, and don't `--no-verify` without an explicit justification line in the commit body.

### Full implementation campaigns

When the operator explicitly authorizes a full implementation plan, treat that plan as the approved task scope. Do not stop merely because the plan is large, spans multiple packages, requires docs/tests/self-test updates, or needs multiple PRs.

For an approved implementation campaign:

- use multi-agent orchestration for broad feature buildout when available, with one orchestrator coordinating bounded subagents so context and tokens stay efficient
- create fresh branches from `main` and use git worktrees for isolated parallel PR lanes when helpful
- make small, green commits after `pnpm check` or the agreed focused gate passes
- push branches and open PRs for major reviewable slices where practical
- keep RBAC/scoped service tokens as a separate PR when that work is in scope
- update docs, examples, schemas/OpenAPI, and self-test coverage before calling a slice complete
- run live validation where applicable, while serializing full live `skelm-self-test` passes that depend on local models
- treat completion as full implementation complete, docs updated and checked, unit tests green, and live validation done
- continue through the full approved plan until implemented and validated, or stop only for an explicit blocker, security/product decision, unavailable required model/tool, failing unrelated baseline that cannot be isolated, or operator direction

## Tests are mandatory for behavior changes

- **Permissions, audit, security paths** — adversarial tests proving default-deny on omission **and** explicit-deny on violation.
- **Backends** — pass the backend-contract suite.
- **Public CLI commands** — spawn the bin against a fixture; assert exit code, stdout, stderr.
- **Gateway HTTP endpoints** — happy-path + auth-failure + validation-failure each.

If you're tempted to skip tests for "obvious" code, that code will surprise you in production.

**Coverage targets:** runtime, dispatcher, context, and permission enforcement should hold ≥95% line coverage, with **100% branch coverage on permission enforcement**. Every documented CLI exit code has a test.

## Git hooks

Install local hooks with `bash scripts/install-git-hooks.sh`. The commit-msg hook
validates conventional, descriptive commit messages and wraps body lines under
80 characters. The optional pre-push hook runs `pnpm check` locally. CI runs
`pnpm check` on every push and PR with no `continue-on-error` anywhere.

## Repo-specific invariants

### The gateway is the trust boundary AND the execution surface

All security infrastructure — permission resolution, permission enforcement, secret resolution, approvals, audit-log writing — is owned by the gateway. The runtime does not enforce permissions; the gateway does. Backends do not write audit; the gateway does. Tools do not resolve secrets; the gateway does.

The CLI is a thin client over the gateway HTTP surface. Non-exempt commands (`run`, `list`, `describe`, `history`, `audit`, `workspace`, `secrets`) dispatch to the gateway and do NOT execute pipelines in-process. The CLI must NOT import `runPipeline`, `Runner`, `EventBus`, `SqliteRunStore`, `SkillRegistry`, `ChainAuditWriter`, `FileSecretResolver`, `EnvSecretResolver`, or `WorkspaceManager` from anywhere except the gateway-bootstrap helpers under `packages/cli/src/gateway.ts` and `validate.ts`. The guard at `scripts/guards/cli-no-core-runtime.ts` enforces this as part of `pnpm guards`.

Exempt CLI commands (run without a live gateway): `help`, `version`, all `gateway *` subcommands, `init`, `validate`.

When you write code that takes a privileged action (exec, network, fs-write, tool dispatch), route it through the gateway's enforcement helper. The guard at `scripts/guards/gateway-only-enforcement.ts` runs as part of `pnpm guards` — it fails on new `node:child_process` imports outside the allowlist without a `// @subprocess-ok: <reason>` annotation. See `scripts/guards/README.md`.

### Default-deny is structural

`AgentPermissions` fields default to `undefined`, which the runtime treats as deny. When adding a new permission dimension:

1. Field is optional and defaults to `undefined`.
2. Runtime treats `undefined` as deny.
3. Add an adversarial fixture under `packages/core/test/security/` (the directory `scripts/guards/default-deny-permissions.ts` scans) proving the deny path fires.
4. Document the dimension in the relevant `docs/` page.

`scripts/guards/default-deny-permissions.ts` checks 1–3 mechanically as part of `pnpm guards`.

## Self-review before opening a PR

Review your own branch diff before requesting human review, weighting the
security tenet first: every new privileged action (exec, network, fs-write, tool
dispatch) routes through the gateway enforcement helper; every new permission
dimension defaults to deny and has an adversarial fixture; no secret value
reaches logs, audit, or error messages.

State the security implications explicitly in the PR description — or "no
security impact" with a one-line reason. Address every actionable finding, or
note in the PR why you're deferring.

## Public API

Anything exported from a package's top-level `index.ts` is public. Anything inside a subpath without an explicit `exports` entry is internal. Public API changes update the matching baseline at `scripts/guards/baselines/<package>.txt` in the same commit — `scripts/guards/public-export-baseline.ts` runs as part of `pnpm guards` and fails on drift.

## Code style

- TypeScript strict everywhere. No `any` without a justification comment immediately above.
- Biome handles lint and format at pre-commit; don't hand-format.
- Package imports first, then relative. No circular imports.
- Typed errors from `@skelm/core/errors`. Never throw bare strings.
- Schemas are standard-schema-compatible (Zod is the documented default). Validate at system boundaries.

## Commits and PRs

- Conventional prefixes: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`.
- Commit messages must be descriptive without being wordy. Use a clear
  subject plus a short body for every non-trivial commit. The body should say
  what changed/fixed/added, why it was needed, and any important validation or
  risk context. Keep it concise: a few focused sentences or bullets are enough.
  Wrap commit message body lines under 80 characters.
- Truly mechanical commits, such as formatting-only churn or typo-only docs
  edits, may omit the body only when the subject fully explains the change.
- One logical change per commit; one per PR. Stack PRs when a feature naturally splits.
- PR description: what changed, why, how it was tested, security implications.
- Don't reference internal note paths or rule identifiers in commit messages — they're read by anyone who later runs `git log`.

## Things to never do

- **Never** take a privileged action (exec, network, fs-write, tool dispatch) outside the gateway's enforcement helper. Use the helper or annotate `@gateway-enforced` with a justification.
- **Never** add a second audit-log writer. There is exactly one; everything else logs through it.
- **Never** mock the gateway in security-related tests. Permission enforcement is tested against the real gateway code path.
- **Never** widen permissions silently. A change that grows the default permission set is a security event and must be called out in the PR description.
- **Never** ship code that produces an unhandled rejection or uncaught exception in the gateway's main loop.
- **Never** guess on a security-related question. Escalate immediately — security is the top tenet, and the cost of asking is far below the cost of being wrong.

## Tool guidance for AI assistants

- Use focused edits over full-file rewrites — diffs are easier to review.
- Use `pnpm` for everything Node-related; this repo is a pnpm workspace. Never `npm` or `yarn`.
- Run long-lived processes (`pnpm test:watch`, `skelm gateway start`, watch modes) in the background and read output later.
- Never run destructive git operations (`reset --hard`, `push --force`, `branch -D`) without explicit user approval.
- Track multi-step work in your agent's task list when available, and update status as you go.
- Stay within the scope of the task. Don't expand scope without permission; don't shrink it either.
- For an explicitly approved full implementation campaign, the campaign plan is the scope; complete the whole plan through validated PR-ready slices rather than stopping after a proposal or partial increment.
- When uncertain, ask. The cost of a one-line clarification is low.

### Codegraph MCP

- Use codegraph MCP for structural codebase understanding when available, especially before large edits, cross-package refactors, public API changes, dependency traversal, symbol lookup, or impact analysis.
- Prefer codegraph MCP tools over the codegraph CLI for repo exploration. Use the CLI mainly for index setup or refresh when needed.
- If codegraph is unavailable, stale, or missing an index, record that fallback and use `rg`, direct reads, and nearby tests/docs instead.
- Do not let codegraph replace reading the actual files you are editing. Treat it as a map, then verify behavior and invariants in source and tests.

### For Claude Code specifically

- `Read` for known paths; `Grep`/`Bash` for keyword search; the `Explore` agent only for open-ended cross-codebase searches (slower, uses more context).
- Prefer `Edit` over `Write`. `Write` overwrites; `Edit` is reviewable.
- Use `TaskCreate` for multi-step work and mark items `completed` only when truly done (gates green). Partial work stays `in_progress` with a follow-up task.

## Local development quick reference

```
pnpm install
pnpm check                  # full gates
pnpm test                   # unit + integration
pnpm test:watch             # watch mode

skelm run path/to/foo.pipeline.ts
skelm run path/to/foo.pipeline.ts --events json 2> events.log > result.json

skelm gateway start         # foreground; SIGTERM/Ctrl-C drains and exits
skelm gateway install --systemd
skelm gateway status
skelm gateway stop
```

## End-of-session etiquette

- Summarize what changed in one or two sentences.
- If anything is unverified or undone, say so explicitly.
