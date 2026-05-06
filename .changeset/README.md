# Changesets

This directory holds [changesets](https://github.com/changesets/changesets) —
human-written notes describing what changed in a PR, which packages it
affects, and at what semver bump.

## When you need a changeset

Every PR that changes behavior in a published package
(`packages/*/package.json` not marked `"private": true`). Pure docs, tests,
internal tooling, and `CHANGELOG.md` itself do not need a changeset.

## How to add one

```
pnpm changeset
```

Pick the affected packages and the bump kind:

- **patch** — bug fixes, internal refactors with no API change
- **minor** — additive features, new exports
- **major** — removals, renames, behavior changes that break existing code

Write a one-paragraph summary in the prompt. The tool writes a `.md` file
under `.changeset/` that you commit alongside your code changes.

## What CI checks

The `changelog-present.ts` guard fails any PR that:

1. Touches files under `packages/<pkg>/src/`, AND
2. Does not include either a new file under `.changeset/`, or a comment
   `[skip changeset]` in the PR description.

The escape hatch is intentional — docs-style or trivial PRs can opt out
explicitly, but they have to opt out, not silently skip.

## On release

```
pnpm changeset version
pnpm changeset publish
```

`version` consumes the `.md` files into `CHANGELOG.md` entries and bumps
package versions. `publish` runs `npm publish` for any package whose version
is ahead of the registry.
