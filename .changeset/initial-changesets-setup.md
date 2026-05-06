---
---

Add `@changesets/cli` and the `changelog-present` guard so PRs that change
published-package source must include a changeset (or opt out via
`[skip changeset]` in the PR body). Sets up `.changeset/` with an empty-fixed
config; future PRs use `pnpm changeset` to author entries.
