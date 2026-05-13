#!/usr/bin/env bash
# Publish all skelm packages to GitHub Packages (https://npm.pkg.github.com)
# under the @scottgl9 scope.
#
# What this script does:
#   1. Rewrites `workspace:*` deps to a concrete `^<version>` range.
#   2. Rescopes each package name from `@skelm/*` (and unscoped `skelm`) to
#      `@scottgl9/*`. Internal `dependencies` keep their `@skelm/*` names so
#      transitive deps install anonymously from npmjs.org — consumers only
#      need GitHub auth for the `@scottgl9` scope.
#   3. Publishes every package to https://npm.pkg.github.com.
#   4. Restores the working tree.
#   5. Probes each package's visibility and prints the per-package settings
#      URLs for any that are still private (GitHub provides no REST API to
#      flip user-scoped package visibility — a one-click manual step is the
#      only way today).
#
# Required environment:
#   GH_PACKAGES_TOKEN   classic PAT with `write:packages, read:packages, repo`
#                       scope (the `repo` scope is needed so the package can
#                       link to its source repo)
#
# Usage:
#   GH_PACKAGES_TOKEN=ghp_xxx scripts/publish-gh-packages.sh [VERSION]
#   DRY_RUN=1 GH_PACKAGES_TOKEN=ghp_xxx scripts/publish-gh-packages.sh

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -z "${GH_PACKAGES_TOKEN:-}" ]; then
  echo "error: GH_PACKAGES_TOKEN must be set (classic PAT with write:packages,read:packages,repo)" >&2
  exit 1
fi

VERSION="${1:-$(node -p "require('./packages/skelm/package.json').version")}"
PUBLISH_ORDER=(core scheduler integrations metrics otel opencode pi vercel-ai agent gateway cli skelm)

echo "==> skelm publish to GitHub Packages"
echo "    version: $VERSION"
echo "    dry run: ${DRY_RUN:-0}"

echo "==> sync versions"
for pkg in "${PUBLISH_ORDER[@]}"; do
  (cd "packages/$pkg" && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null)
done

echo "==> install + build"
pnpm install --frozen-lockfile
pnpm build

echo "==> rewrite workspace:* deps"
node scripts/rewrite-workspace-deps.mjs rewrite

echo "==> rescope to @scottgl9"
node scripts/rescope-gh-packages.mjs apply

# Trap restores BOTH transformations even if publish fails.
trap '
  echo "==> restore working tree"
  node scripts/rescope-gh-packages.mjs restore || true
  node scripts/rewrite-workspace-deps.mjs restore || true
' EXIT

echo "==> publish"
for pkg in "${PUBLISH_ORDER[@]}"; do
  pkg_name="$(node -p "require('./packages/$pkg/package.json').name")"
  echo "    -> $pkg_name@$VERSION"
  (
    cd "packages/$pkg"
    if [ "${DRY_RUN:-0}" = "1" ]; then
      npm publish --access public \
        --registry=https://npm.pkg.github.com \
        --//npm.pkg.github.com/:_authToken="$GH_PACKAGES_TOKEN" \
        --dry-run
    else
      npm publish --access public \
        --registry=https://npm.pkg.github.com \
        --//npm.pkg.github.com/:_authToken="$GH_PACKAGES_TOKEN"
    fi
  )
done

if [ "${DRY_RUN:-0}" != "1" ]; then
  echo
  GH_PACKAGES_TOKEN="$GH_PACKAGES_TOKEN" \
    node scripts/check-gh-visibility.mjs
fi
