# CLAUDE.md

Guidance for Claude (and Claude Code) when working in this repository. Read this alongside [`AGENTS.md`](./AGENTS.md), which contains the bulk of contributor guidance shared with all coding assistants. This file is the Claude-specific layer.

## What skelm is

A TypeScript-first framework for authoring, running, and operating agentic and deterministic pipelines. The high-level unit is a **pipeline** — a typed, inspectable, executable orchestration that may be a single agent or a complex multi-step workflow. Pipelines run via a CLI, are hosted by a long-running gateway service, and integrate with LLMs, agent runtimes, and tool servers under explicit, default-deny permissions.

## Tenets (in priority order)

1. **Security** — default-deny everywhere; agent permissions are part of the API.
2. **Maintenance** — small core, narrow public surface, replaceable internals.
3. **Robustness for long-running workflows** — typed context, explicit errors, durable state.

## How to operate here

### Read before you write

For any non-trivial change:

1. Read the touched module's TSDoc and the package `README.md`.
2. Read at least one test file in the touched area to learn the testing idiom.
3. If the change touches the gateway, security, or public API, also read the corresponding section of `docs/`.

If a quick read does not give you enough context to predict what will break, that is signal to read more, not signal to start writing.

### Prefer existing utilities

Before writing a new helper, search the package for an existing one. skelm has small focused utilities by design; new helpers proliferate quickly if not checked. When you find an existing helper that almost fits, extend it rather than parallel-implementing.

### Default to no comments

Only add a comment when the *why* is non-obvious — a hidden constraint, a subtle invariant, a workaround for a specific bug. Don't explain what the code does. Don't reference the current task or fix. Don't write multi-paragraph docstrings. One short line max.

### Tests are not optional

Every behavior change ships with tests. Specifically:

- **Permission, audit, security paths**: adversarial tests proving default-deny on omission AND explicit-deny on violation. Both, not either.
- **Backends**: must pass the backend-contract suite.
- **CLI**: spawn the bin against a fixture, assert exit code + stdout + stderr.
- **Server endpoints**: happy-path + auth-failure + validation-failure each.

If you are tempted to skip tests for "obvious" code, that is signal that the code path will surprise you in production.

### Run the gates before declaring done

```
pnpm check
```

This runs build, typecheck, lint, unit, guards, adversarial, contract, doc-links — in order. CI runs the same. Local runs are faster than the CI round-trip; use them.

### Implementation discipline

For every feature, fix, or behavior change you make:

1. **Build first** — `pnpm build` succeeds.
2. **Update or write tests** — new behavior is covered; changed behavior has updated coverage.
3. **Run all tests** — `pnpm check` passes top to bottom.
4. **Only then is the work done.**

If any of those steps fail, the work is not finished — fix it before declaring complete. A claim of "done" against a red tree is a defect on your part. Do not commit, do not let the user commit on your behalf, until everything is green.

### Big features: commit and push every validated step

Large features land in **small, green increments**:

1. Make a focused change.
2. Run `pnpm check` — pass.
3. Validate the increment (smoke test, fixture run, targeted test).
4. Commit with a clear message.
5. Push.
6. Continue with the next increment.

Do not pile up a long unpushed work tree. The user reviews work by reading commits in order; tiny green commits are easier to review than one giant commit. If you complete a big feature, expect to have pushed several commits along the way — that rhythm is the goal, not a fallback.

Ask the user to confirm before the first commit on a fresh feature so the commit cadence is aligned. After that, proceed at the pace of the loop above unless the user asks otherwise.

## Tool use guidance for Claude Code

### Reading

- Use `Read` for known file paths. Use `Grep`/`Bash` for keyword search. Use the `Explore` agent only for open-ended cross-codebase searches; for targeted lookups, the direct tool is faster and uses less context.

### Editing

- Prefer `Edit` over `Write`. `Write` overwrites; `Edit` is reviewable.
- Match existing indentation exactly. Two spaces in TS, tabs only where existing files already use tabs.
- Never edit generated files (anything under `dist/`, `coverage/`, `.skelm/`).

### Bash

- Use `pnpm` for everything Node-related. The repo is a pnpm workspace.
- Long-running processes (`pnpm dev`, `skelm gateway start`) belong in the background — use `run_in_background: true` and read output later.
- Do not run destructive git operations (`reset --hard`, `push --force`, `branch -D`) without explicit user approval.

### Tasks

- For multi-step work, use `TaskCreate` and update status as you go. The user uses these to track what you are doing.
- Mark a task `completed` only when it is actually done — tests passing, gates green. If something is partial, leave it `in_progress` and create a follow-up task.

## Things specific to this repo

### The gateway is the trust boundary

All security infrastructure — permission resolution, permission enforcement, secret resolution, approvals, audit log writing — is owned by the gateway. The runtime does not enforce permissions; the gateway does. Backends do not write audit; the gateway does. Tools do not resolve secrets; the gateway does.

When you are about to write code that touches a privileged action (exec, network, fs-write, tool dispatch), the answer is **always** to route it through the gateway's enforcement helper. A CI guard for this rule (`scripts/guards/gateway-only-enforcement.ts`) is **active** and runs as part of `pnpm guards` — it will fail if you add a new `node:child_process` import outside the allowlist without a `// @subprocess-ok: <reason>` annotation. See `scripts/guards/README.md` for the allowlist and annotation convention.

### Default-deny is structural

`AgentPermissions` fields default to `undefined`, which the runtime treats as deny. When you add a new permission dimension:

1. The field is optional and defaults to `undefined`.
2. The runtime treats `undefined` as deny.
3. You add an adversarial fixture under `tests/security/` proving the deny path fires.
4. You document the dimension in the relevant `docs/` page.

A guard script (`scripts/guards/default-deny-permissions.ts`) checks 1–3 mechanically and runs as part of `pnpm guards`. See `scripts/guards/README.md`.

## When you are uncertain, ask

If you are unsure whether a change is in scope, whether a test is sufficient, whether a permission default is right, or whether a public-API change is intended — ask the user. The cost of a one-line clarification is low; the cost of an unwanted change is high.

If the user has explicitly authorized scope (e.g., "implement X end-to-end"), proceed within that scope and check in at natural breakpoints. Don't expand scope without permission; don't shrink it either.

## Local development quick reference

```
pnpm install
pnpm check                  # full gates
pnpm test                   # unit + integration
pnpm test --watch           # watch mode
pnpm dev                    # vitest watch on the workspace

skelm run path/to/foo.pipeline.ts
skelm run path/to/foo.pipeline.ts --events json 2> events.log > result.json

skelm gateway start         # foreground; SIGTERM/Ctrl-C drains and exits
skelm gateway install --systemd   # install user systemd unit for cross-reboot
skelm gateway status
skelm gateway stop
```

## End of session etiquette

When you finish a unit of work:

- Summarize what changed in one or two sentences. What was modified, what was tested.
- If anything is left undone or unverified, say so explicitly.
- Do not auto-commit. The user runs `git commit` when they decide the work is ready.
