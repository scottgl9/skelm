# Design: P4 — Public surface tightening

Tracking: [#27](https://github.com/scottgl9/skelm/issues/27)

## Goal

Land a clean public-API boundary before the v1 cut so that:

1. Every export in a package's top-level `index.ts` is intentionally public.
2. Anything experimental, internal, or in-flight is explicitly marked or moved
   off the top-level surface.
3. The export baselines under `scripts/guards/baselines/<pkg>.txt` are the
   single source of truth for what's public.

This is a tenet-2 (maintenance) deliverable — a smaller surface ages better.

## Current state (snapshot)

Baselines today (line counts via `wc -l scripts/guards/baselines/*.txt`):

| Package          | Lines | Notes                                                |
| ---------------- | ----- | ---------------------------------------------------- |
| core             | 227   | The big one. Mixes runtime, types, providers, triggers |
| gateway          |  81   | Audit, secrets, approvals, registries                |
| integrations     |  21   | Slack, GitHub today                                  |
| pi               |  22   |                                                      |
| scheduler        |  20   |                                                      |
| opencode         |  17   |                                                      |
| cli              |  14   | Programmatic entry only                              |
| otel             |   3   |                                                      |
| metrics          |   1   |                                                      |
| skelm (meta)     |   1   |                                                      |

`@experimental` JSDoc usage in `packages/*/src/*.ts`: only one occurrence
(`run-store-postgres.ts`). The rest of the surface is implicitly stable, even
where it shouldn't be.

## Phased plan

### Phase 1 — Audit pass (read-only)

For each package, classify every top-level export into one of:

- **stable**: relied on by examples, contract tests, or fixtures; backwards
  compatibility is mandatory.
- **experimental**: in-flight; reserve the right to change. JSDoc tag.
- **internal**: should not be public; will be moved.

Outputs a CSV under `planning/p4/<pkg>.csv` with columns
`name,kind,classification,evidence`. Evidence is a grep result showing where
the export is actually used.

### Phase 2 — Move internals off the top-level

- Internal exports move to `packages/<pkg>/src/internal/` and stay accessible
  via a `./internal` subpath export from `package.json` only when consumers
  outside the package legitimately need them.
- Update fixtures and tests to use the new subpath.
- Regenerate baselines; they should shrink.

### Phase 3 — Tag experimental APIs

- Add `@experimental` JSDoc to every export classified as experimental.
- Document the tag's contract in `docs/concepts/api-stability.md`: experimental
  exports may change in any minor; stable exports follow semver.

### Phase 4 — CI guard hardening

The `public-export-baseline.ts` guard already fails CI on diffs. Harden it to:

- Distinguish stable from experimental in the baseline file itself
  (e.g., a `# experimental:` section).
- Refuse a PR that promotes an experimental export to stable without an
  accompanying changeset (depends on #35).

## Acceptance criteria

- [ ] `planning/p4/<pkg>.csv` exists for every package and is committed.
- [ ] Baselines reflect the post-move surface; CI green.
- [ ] Every experimental export carries an `@experimental` JSDoc tag.
- [ ] `docs/concepts/api-stability.md` documents the contract.
- [ ] `public-export-baseline.ts` understands the experimental section.

## Risks

- **Breaking downstream code.** Any move off the top-level surface is a
  breaking change. Land Phase 2 in a single major-bump PR; do not split.
- **CSV bitrot.** The audit CSVs are point-in-time. Keep them as
  documentation of the v1 decision; do not maintain after the cut.
- **Bikeshedding stable vs experimental.** Default to experimental when in
  doubt — a future promotion is cheap; a future demotion is a major bump.

## Out of scope

- Any backwards-compat shims after the v1 cut. Pre-v1 we are free to break.
- New exports. This issue is about closing the surface, not opening it.
