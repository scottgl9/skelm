# Publishing Guide — npmjs.org

skelm publishes ten packages to the public npm registry: the `skelm` meta package plus nine `@skelm/*` scoped packages.

## Prerequisites

1. **npm account with publish rights**
   - The account must own the `skelm` package name and the `@skelm` scope
   - Run `npm whoami` to verify you are logged in
   - For CI, generate an automation token: https://www.npmjs.com/settings/<user>/tokens
   - Store the automation token as the `NPM_TOKEN` GitHub Actions secret

2. **2FA on the npm account** (`auth-and-writes` mode is fine; tokens of type `automation` bypass it for CI)

3. **Local toolchain**
   - Node `>=20`
   - `pnpm@8` (the workspace's pinned version)

## Configuration

Each package's `package.json` carries:

```json
{
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "files": ["dist", "README.md", "LICENSE"]
}
```

`publishConfig.access: "public"` is required for the scoped `@skelm/*` packages — without it, npm publishes scoped packages as private and a public publish is rejected.

## Package list

| Package                 | Version source            | Depends on                                  |
| ----------------------- | ------------------------- | ------------------------------------------- |
| `@skelm/core`           | `packages/core`           | (none)                                      |
| `@skelm/scheduler`      | `packages/scheduler`      | `@skelm/core`                               |
| `@skelm/integrations`   | `packages/integrations`   | `@skelm/core`                               |
| `@skelm/metrics`        | `packages/metrics`        | `@skelm/core`                               |
| `@skelm/otel`           | `packages/otel`           | `@skelm/core`, `@opentelemetry/api`         |
| `@skelm/opencode`       | `packages/opencode`       | `@skelm/core` (peer), `@opencode-ai/sdk`    |
| `@skelm/pi`             | `packages/pi`             | `@skelm/core` (peer)                        |
| `@skelm/gateway`        | `packages/gateway`        | `@skelm/core`, `@skelm/metrics`, `h3`       |
| `@skelm/cli`            | `packages/cli`            | `@skelm/core`, `@skelm/opencode`, `@skelm/pi`, `@skelm/gateway`, `tsx` |
| `skelm`                 | `packages/skelm`          | `@skelm/core`, `@skelm/cli`                 |

Versions move in lockstep — every release publishes all ten at the same version.

## Publishing methods

### Method 1 — GitHub Actions (recommended)

Push a release tag and the `Publish to npm` workflow handles the rest.

```bash
# Bump every package version, commit, push
node -e "console.log(require('./packages/skelm/package.json').version)"  # current
# (use scripts/publish-npm.sh dry-run, or `npm version` per package)
git tag v0.3.3
git push origin v0.3.3
# Then create a release at https://github.com/scottgl9/skelm/releases/new
```

The workflow:

1. Installs `pnpm@8`, Node 20.
2. Syncs every package's version to the release tag.
3. Builds and runs `pnpm typecheck` + `pnpm test`.
4. Publishes to npm with `--access public --provenance` (CI uses OIDC; no `NPM_TOKEN` needed if you enable [Trusted Publishers](https://docs.npmjs.com/trusted-publishers) for the package, otherwise it falls back to `NPM_TOKEN`).

**Manual trigger:** Actions → "Publish to npm" → pick a version, optionally enable dry-run.

### Method 2 — Local script

```bash
# Dry run: build, gates, and `npm publish --dry-run`
DRY_RUN=1 scripts/publish-npm.sh 0.3.3

# Real publish (requires `npm whoami` to succeed)
scripts/publish-npm.sh 0.3.3
```

The script syncs all package versions, runs the full gate (`build` → `typecheck` → `test`), then publishes in dependency order: `core → scheduler → integrations → metrics → otel → opencode → pi → gateway → cli → skelm`.

### Method 3 — Manual, package by package

Useful when re-publishing a single package after a registry hiccup.

```bash
# Authenticate
npm login

# In each package directory
cd packages/core
npm version 0.3.3 --no-git-tag-version --allow-same-version
pnpm build
npm publish --access public --provenance
```

## Versioning

Everything is pre-v1, so the policy is:

- **patch** (`0.3.3 → 0.3.4`) — bug fixes, doc updates, no shape change.
- **minor** (`0.3.x → 0.4.0`) — feature additions; **may** contain breaking API changes (we are still 0.x).
- **major** — reserved for v1 stabilization.

Document anything user-visible in [`CHANGELOG.md`](../CHANGELOG.md). Until v1 ships, breaking changes go in the changelog under a clear "Breaking" heading.

## Provenance

CI uses `npm publish --provenance`, which signs each tarball with a Sigstore certificate tied to the GitHub Actions workflow run. End users see the verified-publisher badge on npm. Local publishes do not sign — prefer CI for releases.

## Troubleshooting

**`E403 Forbidden`** — token lacks write rights, or scope `@skelm` is owned by a different account. Run `npm whoami` and `npm access list packages` to inspect.

**`E400 Bad Request: cannot publish over previously published version`** — the version already exists. Bump and retry; npm does not allow republishing the same version.

**Workspace deps published as `workspace:*`** — `npm publish` does **not** rewrite `workspace:*`; only `pnpm publish` does. If a tarball ships with literal `workspace:*` deps, consumers get `EUNSUPPORTEDPROTOCOL` on install. Always publish with `pnpm publish --no-git-checks` (or use `scripts/publish-npm.sh`, which does this for you). Once a broken tarball is on the registry the version is burnt — npm forbids re-publishing the same version, so bump and re-release.

**ESM resolution failures after publish** — `package.json` `exports` must point at compiled `dist/*.js` files, not source. Confirm `pnpm build` ran before publish.

## Installing published packages

```bash
# Most users only need this
npm install -g skelm

# Library users
npm install @skelm/core zod

# Gateway operators
npm install @skelm/gateway
```

## Links

- npm registry: https://www.npmjs.com/package/skelm
- npm Trusted Publishers: https://docs.npmjs.com/trusted-publishers
- npm provenance: https://docs.npmjs.com/generating-provenance-statements
- Source: https://github.com/scottgl9/skelm
