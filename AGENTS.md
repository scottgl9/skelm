# AGENTS.md

Guidance for AI coding assistants and human contributors working on **skelm** — a TypeScript-first framework for authoring, running, and operating agentic and deterministic pipelines.

## What skelm is

skelm is a Node/TypeScript framework. The high-level unit is a **pipeline**: a typed, inspectable, executable orchestration that may be a single agent, a multi-step workflow with parallel branches, loops, and nested pipelines, or anything in between. Pipelines run from the CLI, are hosted by a long-running gateway service, and integrate with LLMs, agent runtimes, and tool servers under explicit, default-deny permissions.

If you are about to make a change to this repo, you are working on framework code that other developers and enterprises will depend on. Treat every change accordingly.

## Tenets

These are the tiebreakers. When goals conflict, the higher tenet wins.

1. **Security.** Pipelines run user code, invoke LLMs, and may drive agents with executable tools. Default-deny is the design posture. Agent permissions (allowed executables, skills, tool servers, tools, network egress, fs roots) are part of the authoring API, not an afterthought. A backend that cannot enforce a declared permission must fail at step start rather than silently bypass it.
2. **Ease of maintenance.** A small core, single-sourced vocabulary, narrow public surface, no DSL. Internals are replaceable; the API is stable. Every package boundary exists to keep blast radius small under future change.
3. **Robustness for long-running workflows.** Once a pipeline is authored, it runs reliably: typed context end-to-end, explicit error semantics, deterministic event log, durable wait/resume, no implicit magic. Failures are observable; recovery is explicit.

These tenets explicitly outrank performance, surface area, and feature breadth.

## Repo shape

```
skelm/
├── packages/
│   ├── core/        — runtime, types, builders, run store, MCP host
│   ├── cli/         — bin: skelm
│   ├── server/      — HTTP + SSE surface
│   └── gateway/     — long-running service, embeds server + scheduler
├── pipelines/
│   └── internal/    — skelm dogfooding pipelines (review, test-gen, release)
├── examples/
├── scripts/
│   └── guards/      — small focused architectural-invariant checks
├── tests/
└── docs/            — public documentation
```

`planning/` and `plan.md` (if present locally) are internal design notes, gitignored, not part of the shipped repository.

## Working with the codebase

### Before you change anything

- Read the relevant package's `README.md` and the touched module's TSDoc.
- Run `pnpm check` once on a clean tree to confirm the gates are green before you start. If gates are red on `main`, fix or revert before opening a PR for unrelated work.
- For non-trivial changes, sketch the diff in your head and check it against the tenets above. If a change makes the framework less secure, less maintainable, or less robust without a clear win in another tenet, reconsider.

### While you work

- Prefer editing existing files to creating new ones.
- Default to writing no comments. Only add one when the *why* is non-obvious — a hidden constraint, a subtle invariant, a workaround. Do not explain what the code does; well-named identifiers do that.
- Avoid TODO comments. If something needs doing, open an issue or do it.
- Do not add features, refactor, or introduce abstractions beyond what the task requires. A bug fix doesn't need surrounding cleanup; a one-shot doesn't need a helper.
- Do not add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Validate at system boundaries (user input, external APIs, plugin entries).

### Implementation discipline (non-negotiable)

Every new feature, bug fix, or behavior change follows this loop **before any commit lands**:

1. **Build.** `pnpm build` succeeds with no TypeScript errors and no warnings escalated to errors.
2. **Update or write tests.** New behavior gets new tests. Changed behavior gets the existing tests updated. No exceptions for "obvious" code.
3. **Run all tests.** `pnpm check` passes — every gate, in order. Build, typecheck, lint, unit, guards, adversarial security fixtures, backend-contract suite, doc-link verification.
4. **Commit only when green.** A commit on a red tree is a defect. Pre-commit hooks block obvious failures; CI catches the rest.

If a change is large enough that intermediate states are red, develop on a branch and squash. Never push a red commit to `main`. Never bypass the pre-commit hook (`--no-verify`) without an explicit justification line in the commit body.

### Big features: commit and push at every validated checkpoint

Large features are landed in **small, green increments**. The rhythm:

1. Make a focused change (one decision per commit).
2. Run `pnpm check` — pass.
3. Validate the increment (manual smoke, fixture run, or specific test that exercises the new path).
4. Commit with a clear message.
5. Push to the working branch.
6. Continue.

Do not accumulate a week of unpushed work. The branch is the unit of review; the commit is the unit of audit. A reviewer should be able to trace a feature by reading commits in order. A 2,000-line PR with one commit is harder to review well than ten 200-line commits, even when the code is identical.

The pattern applies whether you are a human contributor or an AI assistant: validate the increment, commit it green, push, continue.

### Tests are mandatory for behavior changes

Every behavior change ships with tests:

- **Permissions, audit, and security paths** carry adversarial tests that prove default-deny on omission and explicit-deny on violation.
- **Backends** must pass the backend-contract suite.
- **Public CLI commands** are tested by spawning the bin against a fixture project and asserting exit codes, stdout, and stderr.
- **Server endpoints** carry a happy-path, an auth-failure, and a validation-failure test each.

Coverage floors:
- Runtime, dispatcher, context, permission enforcement: ≥95% line, **100% branch on permission enforcement**.
- CLI exit codes: every documented exit code has a test.

### Public API stability

Anything exported from a package's top-level `index.ts` is part of the public API. Anything inside a subpath without an explicit `exports` entry is internal. Public API changes require updating the API baseline file in the same commit; a CI guard for this (`scripts/guards/public-export-baseline.ts`) is planned but not yet implemented — see `scripts/guards/README.md`.

## Quality gates

Single entry point for all gates:

```
pnpm check
  → build
  → typecheck
  → lint              (biome)
  → unit              (vitest)
  → guards            (architectural-invariant scripts under scripts/guards/ — currently no-op; see scripts/guards/README.md for the implementation backlog)
  → adversarial       (security-tenet adversarial fixtures)
  → contract          (backend-contract suite)
  → doc-links
```

The same gates run in CI. Do not skip them locally; the round-trip from CI failure to fix is more expensive than running `pnpm check` once before pushing.

A pre-commit hook runs format-and-restage on staged files. Do not bypass it (`--no-verify`) without an explicit justification line in the commit body explaining why.

### Opt-in pre-push gate

CI is the merge gate (`.github/workflows/ci.yml` runs `pnpm check` on every push and PR, with no `continue-on-error` anywhere). To catch the same class of regression before push instead of after, run:

```
bash scripts/install-git-hooks.sh
```

This sets `core.hooksPath` for the repo and installs a `pre-push` hook that runs `pnpm check` locally. Bypass with `git push --no-verify` if you really mean to push a red branch. Uninstall with `git config --unset core.hooksPath`.

## Self-review before opening a PR

skelm is dogfood-driven: there is an internal `branch-review` pipeline (under `pipelines/internal/`) that runs an agent-driven review of your branch against `main`. Run it before opening a PR:

```
skelm run pipelines/internal/branch-review.pipeline.ts --input '{"branch":"my-branch"}'
```

The review produces a structured result with sections for summary, changes, security findings, design alignment, robustness, maintenance, and follow-ups. The security section must be non-empty (or carry an explicit justified-empty marker). Address every actionable finding before requesting human review, or note in the PR why you are deferring.

## Code style

- TypeScript strict everywhere. No `any` without a justification comment immediately above.
- Biome for lint and format. The pre-commit hook handles formatting; do not hand-format.
- Imports: package imports first, then relative. No circular imports.
- Errors: typed error classes from `@skelm/core/errors`. Never throw bare strings.
- Schemas: standard-schema-compatible (Zod is the documented default). Validate at system boundaries.
- Default-deny in security-relevant types: every new field of `AgentPermissions` defaults to `undefined` (treated as deny) and ships with an adversarial fixture exercising the deny path. A CI guard for this (`scripts/guards/default-deny-permissions.ts`) is planned but not yet implemented — see `scripts/guards/README.md`.

## Commits and PRs

- Conventional-style commit messages (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`).
- One logical change per commit; one logical change per PR. Stack PRs if a feature naturally splits.
- PR descriptions include: what changed, why, how it was tested, and any security implications.
- Do not reference internal note paths or internal rule identifiers in commit messages or PR descriptions; commits are read by anyone who later runs `git log`.

## Things to never do

- **Never** write code that takes a privileged action (exec, network, fs-write, tool dispatch) outside the gateway's enforcement helper. Use the helper or annotate `@gateway-enforced` with a justification. CI guards this.
- **Never** add a second audit-log writer. There is exactly one writer module; everything else logs through it.
- **Never** mock the gateway in security-related tests. The gateway is the trust boundary; tests of permission enforcement run against the real gateway code path (in-process is fine, mocked is not).
- **Never** widen permissions silently. A change that grows the default permission set is a security event and must be called out in the PR description.
- **Never** ship code that produces an unhandled rejection or an uncaught exception in the gateway's main loop. Crash-only design where it makes sense (within a run); never within the gateway lifecycle.

## Where to ask

- For framework design questions, read the relevant package's TSDoc first, then `docs/`.
- For API ergonomics questions, write the call site you wish you had and propose it in an issue.
- For security-related questions, escalate immediately rather than guessing — security is the top tenet.

If you are an AI coding assistant: stay within the scope of the task you were given, prefer reading before writing, and run `pnpm check` after non-trivial changes. When uncertain, ask the user before taking actions that touch the gateway, security, or public API.
