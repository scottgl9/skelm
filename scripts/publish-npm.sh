#!/usr/bin/env bash
# Publish all skelm packages to npmjs.org.
#
# Prerequisites:
#   - You are logged in: `npm whoami` reports your account
#   - The @skelm scope and `skelm` package name are owned by that account
#   - NPM_TOKEN is set if running non-interactively (CI uses GitHub OIDC + provenance)
#
# Usage:
#   scripts/publish-npm.sh [VERSION]            publish at VERSION (default: derived from packages/skelm/package.json)
#   DRY_RUN=1 scripts/publish-npm.sh 0.3.3      verify config + tarball without uploading
#
# Order is dependency-aware: core first, then leaf backends, then cli/gateway/skelm.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./packages/skelm/package.json').version")}"
PUBLISH_ORDER=(core scheduler integration-sdk integrations metrics otel opencode codex pi vercel-ai agent gateway cli skelm)

echo "==> skelm publish to npmjs.org"
echo "    version: $VERSION"
echo "    dry run: ${DRY_RUN:-0}"
echo "    order:   ${PUBLISH_ORDER[*]}"
echo

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm is required" >&2
  exit 1
fi

echo "==> sync versions"
for pkg in "${PUBLISH_ORDER[@]}"; do
  (cd "packages/$pkg" && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null)
done

echo "==> install + build + gates"
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test

# Rewrite workspace:* dependencies to concrete ranges before publish. pnpm
# publish does this in-tarball, but we do it on-disk too so the result is
# identical regardless of which publish CLI runs, and so a botched run leaves
# audit-friendly evidence on disk. The trap restores the originals even if
# publish fails midway.
echo "==> rewrite workspace:* deps"
node scripts/rewrite-workspace-deps.mjs rewrite
trap 'echo "==> restore workspace:* deps"; node scripts/rewrite-workspace-deps.mjs restore' EXIT
node scripts/rewrite-workspace-deps.mjs check

echo "==> publish"
for pkg in "${PUBLISH_ORDER[@]}"; do
  pkg_name="$(node -p "require('./packages/$pkg/package.json').name")"
  echo "    -> $pkg_name@$VERSION"
  (
    cd "packages/$pkg"
    if [ "${DRY_RUN:-0}" = "1" ]; then
      npm publish --access public --dry-run
    else
      if [ "${CI:-}" = "true" ]; then
        npm publish --access public --provenance
      else
        npm publish --access public
      fi
    fi
  )
done

echo
echo "==> done"
