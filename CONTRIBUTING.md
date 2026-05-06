# Contributing to skelm

Thanks for your interest. skelm is built in the open and contributions — bug reports, design feedback, documentation fixes, and code — are welcome.

This document is the short version. The deep contributor guide is [`AGENTS.md`](./AGENTS.md); the Claude-specific operating notes are [`CLAUDE.md`](./CLAUDE.md). Read those before sending non-trivial changes.

## Prerequisites

- **Node.js ≥ 20**
- **pnpm ≥ 8.15** (this repo is a pnpm workspace; npm/yarn will not work)
- A POSIX shell. Linux and macOS are tested; Windows users should use WSL.

## Getting started

```sh
git clone https://github.com/scottgl9/skelm.git
cd skelm
pnpm install
pnpm check         # build + typecheck + lint + guards + tests
```

`pnpm check` runs the same gates CI runs. If it is green locally, your PR will (almost always) be green in CI.

### Useful scripts

```sh
pnpm build              # tsc -b across packages
pnpm typecheck          # tsc --noEmit across packages
pnpm lint               # biome check
pnpm format             # biome format --write
pnpm test               # vitest run
pnpm test --watch       # vitest watch
pnpm guards             # architectural / security / surface guards
pnpm clean              # remove dist/ + node_modules/
```

To run the CLI from a fresh checkout against a workflow file:

```sh
pnpm --filter skelm build
node packages/skelm/dist/bin.js run path/to/foo.workflow.ts
```

## Branching

- Branch from `main`, not from another feature branch.
- Use a kebab-case prefix that signals intent:
  - `feat/<topic>` — new behavior
  - `fix/<topic>` — bug fix
  - `docs/<topic>` — documentation only
  - `refactor/<topic>` — no behavior change
  - `test/<topic>` — tests only
  - `chore/<topic>` — tooling, deps, CI

## Commits

skelm follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Examples from the existing log:

```
feat(cli): skelm schedule add|list|stop|fire + DELETE /schedules/:id
fix(core): ACP backend model selection + structured output fallback
docs(recipes): OTel traces wiring + linked from index
test(security): pin per-dimension default-deny + explicit-mismatch denials
chore(cli): mark @skelm/cli private:true
refactor(cli): describe command uses shared describePipeline from core
```

Common types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`. Optional scope is the touched area (`core`, `cli`, `gateway`, etc.).

## Pull requests

Before opening a PR:

1. **`pnpm check` is green.** No exceptions.
2. **Tests cover the change.** Behavior changes ship with tests.
   - Permission, audit, and security paths require *adversarial* fixtures proving default-deny on omission and explicit-deny on violation. Both, not either.
   - Backends must pass the backend-contract suite.
   - CLI commands spawn the bin against a fixture and assert exit code + stdout + stderr.
   - Server endpoints have happy-path + auth-failure + validation-failure tests each.
3. **Docs are updated.** Public API changes update the relevant `docs/` page and the package README.
4. **A changeset is included.** Run `pnpm changeset` and commit the generated `.md` under `.changeset/`. Trivial / docs-only PRs may opt out by adding `[skip changeset]` to the PR body. The `changelog-present` guard enforces this.

PR description template:

```markdown
## What
<one or two sentences>

## Why
<motivation, link to issue if any>

## How
<approach; flag anything reviewers should look at>

## Testing
- [ ] pnpm check passes
- [ ] new behavior has unit tests
- [ ] adversarial test for any permission/audit/security path
- [ ] manual smoke test (describe)
```

Open an issue before sending a large PR so we can align on direction.

## Code style

- TypeScript everywhere. Two-space indentation. Trailing commas. `biome` is the formatter and linter.
- **Default to no comments.** Add a short one-liner only when *why* is non-obvious — a hidden constraint, a subtle invariant, a workaround for a specific bug. Don't explain what the code does; well-named identifiers do that.
- **No new dependencies casually.** Prefer the standard library. New deps need justification in the PR description.
- **Public surface is narrow on purpose.** Every new public export goes through the export baseline guard (`scripts/guards/public-export-baseline.ts`) — bumping the baseline requires a deliberate change.

## Security & permissions

- **Default-deny everywhere.** New permission dimensions default to `undefined`, the runtime treats `undefined` as deny, and an adversarial fixture under `tests/security/` proves the deny path fires.
- **The gateway is the trust boundary.** Privileged actions (exec, network, fs-write, tool dispatch) route through the gateway's enforcement helpers. Backends do not write audit; the gateway does.
- **Vulnerability reports** go to the email in [`SECURITY.md`](./SECURITY.md), not to public issues.

## Self-review before opening a PR

The repo includes an internal `branch-review` pipeline:

```sh
skelm run pipelines/internal/branch-review.pipeline.ts --input '{"branch":"<my-branch>"}'
```

It produces a structured review (security, design, robustness, maintenance, follow-ups). Run it before pushing for review and address actionable findings, or note why you're deferring them.

## License

By contributing, you agree your contributions are licensed under the [MIT License](./LICENSE).
