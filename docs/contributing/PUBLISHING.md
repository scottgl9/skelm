# Publishing skelm

skelm is published to two npm registries:

- **npmjs.org** — the canonical home, scope `@skelm`, package name `skelm`. This is the registry `npm install skelm` uses by default. Public.
- **GitHub Packages** — a mirror under `@scottgl9` on `https://npm.pkg.github.com`. Discoverable from the GitHub UI and useful for teams that want a single GitHub-auth code/package surface.

Both registries publish the same compiled tarball. Versions move in lockstep — every release publishes all twelve packages at the same version on both registries.

## Packages

| npmjs.org              | GitHub Packages           | Description                                        |
| ---------------------- | ------------------------- | -------------------------------------------------- |
| `@skelm/core`          | `@scottgl9/core`          | Runtime, types, builders, permissions, event bus   |
| `@skelm/cli`           | `@scottgl9/cli`           | CLI primitives — parser, commands                  |
| `@skelm/gateway`       | `@scottgl9/gateway`       | Long-running HTTP orchestrator                     |
| `@skelm/scheduler`     | `@scottgl9/scheduler`     | Cron / interval / webhook / poll / queue triggers  |
| `@skelm/integrations`  | `@scottgl9/integrations`  | Typed connectors (GitHub, Slack, …)                |
| `@skelm/metrics`       | `@scottgl9/metrics`       | Prometheus metrics                                 |
| `@skelm/otel`          | `@scottgl9/otel`          | OpenTelemetry tracing                              |
| `@skelm/agent`         | `@scottgl9/agent`         | First-party skelm agent backend                    |
| `@skelm/opencode`      | `@scottgl9/opencode`      | Opencode coding-agent backend                      |
| `@skelm/pi`            | `@scottgl9/pi`            | Pi coding-agent backend                            |
| `@skelm/vercel-ai`     | `@scottgl9/vercel-ai`     | Vercel AI SDK backend                              |
| `skelm`                | `@scottgl9/skelm`         | Meta-package — bin + re-exports                    |

The `@scottgl9/*` mirror keeps `@skelm/*` as its `dependencies` targets — transitive deps install anonymously from npmjs.org, so consumers only need GitHub auth for the `@scottgl9` scope, not for the whole tree.

## Versioning

skelm is pre-1.0. Until v1:

- **patch** (`0.3.3 → 0.3.4`) — bug fixes, doc updates, no shape change.
- **minor** (`0.3.x → 0.4.0`) — feature additions; **may** contain breaking API changes.
- **major** — reserved for v1.

Every user-visible change goes in [`CHANGELOG.md`](../CHANGELOG.md) under a clear "Breaking" / "Fixed" / "Added" / "Changed" / "Security" heading.

## Prerequisites

- **Node.js ≥ 20**, **pnpm@8** (this repo's `packageManager`).
- For npmjs publishing: account that owns the `skelm` package + `@skelm` scope. `npm whoami` should report your user.
- For GitHub Packages publishing: a classic PAT (`ghp_…`) with `write:packages, read:packages, repo` scope. The `repo` scope is required so the published package links to its source repository — that link drives the "Public" visibility setting (see below).

## Releasing — the canonical flow

Run from `main`. Replace `0.X.Y` with the new version.

### 1. Bump versions and update the changelog

```bash
# every package, including the workspace root, moves in lockstep
for pkg in core cli gateway scheduler integrations metrics otel agent opencode pi vercel-ai skelm; do
  (cd packages/$pkg && npm version 0.X.Y --no-git-tag-version --allow-same-version)
done
node -e "const fs=require('fs'); const p=require('./package.json'); p.version='0.X.Y'; fs.writeFileSync('package.json', JSON.stringify(p, null, 2)+'\n');"
```

Add a `[0.X.Y]` section to `CHANGELOG.md` (most recent first, under `[Unreleased]`).

### 2. Commit, tag, push

```bash
git add -A
git commit -m "release(0.X.Y): <one-line summary>"
git push origin main
git tag -a v0.X.Y -m "v0.X.Y — <one-line summary>"
git push origin v0.X.Y
gh release create v0.X.Y --title "v0.X.Y" --notes-file <(awk '/^## \[0.X.Y\]/,/^## \[/' CHANGELOG.md | sed '$d')
```

### 3. Publish to npmjs.org

Local script:

```bash
# dry run
DRY_RUN=1 ./scripts/publish-npm.sh 0.X.Y

# real publish (requires `npm whoami` to succeed)
./scripts/publish-npm.sh 0.X.Y
```

Or via GitHub Actions: the **Publish to npm** workflow runs automatically when a release is published.

The script:

1. Syncs every package version with `npm version --allow-same-version`.
2. `pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm test`.
3. Runs `scripts/rewrite-workspace-deps.mjs rewrite` — replaces every `workspace:*` with `^0.X.Y` on disk. A trapped `restore` reverts even if publish fails.
4. Publishes each package in dependency order: `core → scheduler → integrations → metrics → otel → opencode → pi → vercel-ai → agent → gateway → cli → skelm`.

> Why on-disk rewrite? `pnpm publish` rewrites `workspace:*` inside the tarball; `npm publish` does **not**. We rewrite explicitly so every publish path produces an identical tarball, and so a botched run leaves audit-friendly evidence on disk.

Verify by installing in a clean directory:

```bash
mkdir /tmp/smoke && cd /tmp/smoke
echo '{"name":"x","version":"0","private":true,"type":"module"}' > package.json
npm install skelm zod
./node_modules/.bin/skelm --help
```

### 4. Publish to GitHub Packages

```bash
# dry run
DRY_RUN=1 GH_PACKAGES_TOKEN=ghp_xxx ./scripts/publish-gh-packages.sh 0.X.Y

# real publish
GH_PACKAGES_TOKEN=ghp_xxx ./scripts/publish-gh-packages.sh 0.X.Y
```

The script:

1. Syncs versions, installs, builds.
2. Runs `rewrite-workspace-deps.mjs rewrite`.
3. Runs `rescope-gh-packages.mjs apply` — renames each package's `name` to its `@scottgl9/*` form **without** touching the `dependencies` keys. Internal deps therefore still target `@skelm/*` and resolve from npmjs.org. `publishConfig.registry` is set to `https://npm.pkg.github.com` so the publish lands on the right registry without a CLI flag.
4. Publishes each package to `https://npm.pkg.github.com`.
5. Trapped restore returns the working tree to its committed state — both transformations are reverted regardless of how the publish ends.
6. Runs `scripts/check-gh-visibility.mjs`. If any package is still `private`, it prints a list of per-package "Change package visibility" URLs (see next section).

### 5. Flip GitHub Packages visibility to public *(one-click, post-publish)*

GitHub Packages does not honor `--access public` for **user-scoped** packages, and there is no REST API for changing user-scoped package visibility (only org-scoped packages have `PATCH /orgs/{org}/packages/...`). Newly published `@scottgl9/*` packages start `private`. The publish script's final step prints the URLs that need a click:

```
@scottgl9/core           PRIVATE  (linked: scottgl9/skelm)
@scottgl9/cli            PRIVATE  (linked: scottgl9/skelm)
…

The following packages are still PRIVATE.
GitHub provides no API to flip user-scoped package visibility — open each
URL in a browser, scroll to "Danger Zone", click "Change package visibility",
select Public, and confirm by typing the package name:

  https://github.com/users/scottgl9/packages/npm/core/settings
  https://github.com/users/scottgl9/packages/npm/cli/settings
  …
```

Open each, scroll to **Danger Zone → Change package visibility → Public**, and type the package name to confirm. After the first release this is the only manual step in the GitHub Packages flow — once a package version exists, subsequent versions on the *same* package keep its existing visibility, so this is mostly a one-time chore per package.

If GitHub ships a REST endpoint for this, swap the prompt in `check-gh-visibility.mjs` for the API call.

You can re-verify visibility any time with:

```bash
GH_PACKAGES_TOKEN=ghp_xxx node scripts/check-gh-visibility.mjs
```

## Provenance

The npmjs publish workflow runs `npm publish --provenance`, which signs each tarball with a Sigstore certificate tied to the GitHub Actions workflow run. Local publishes do not sign — prefer CI for releases that need verifier badges. GitHub Packages does not currently support npm provenance.

## Consumer install

### From npmjs.org (default)

```bash
# meta-package + bin
npm install -g skelm

# library use
npm install @skelm/core zod

# gateway operators
npm install @skelm/gateway
```

### From GitHub Packages

`.npmrc`:

```
@scottgl9:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

The token needs `read:packages`. Then:

```bash
npm install @scottgl9/skelm
```

Transitive `@skelm/*` deps install anonymously from npmjs.org — the GitHub Packages token is only required for the `@scottgl9` scope.

## Troubleshooting

**`E403 Forbidden` from npmjs** — token lacks write rights, or the `@skelm` scope is owned by another account. Run `npm whoami` and `npm access list packages`.

**`E400 cannot publish over previously published version`** — npm forbids re-publishing the same version. Bump and retry.

**Consumers get `EUNSUPPORTEDPROTOCOL: workspace:*`** — the tarball shipped with literal `workspace:*` deps. The publish path lost the on-disk rewrite (or someone bypassed `scripts/publish-npm.sh`). Bump and re-release; once a broken tarball is on the registry the version is burnt.

**GitHub Packages publish succeeds but the package isn't visible to anonymous consumers** — visibility is still `private`. Run `node scripts/check-gh-visibility.mjs` and follow the printed URLs.

**GitHub Packages publish 404s** — the token is missing `write:packages` *or* the package's `name` doesn't match the GitHub user/org scope (`@scottgl9/...`). Double-check with `node scripts/rescope-gh-packages.mjs check`.

## Links

- npmjs registry: https://www.npmjs.com/package/skelm
- GitHub Packages: https://github.com/scottgl9?tab=packages
- npm Trusted Publishers: https://docs.npmjs.com/trusted-publishers
- npm provenance: https://docs.npmjs.com/generating-provenance-statements
- GitHub Packages npm: https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry
- Source: https://github.com/scottgl9/skelm
