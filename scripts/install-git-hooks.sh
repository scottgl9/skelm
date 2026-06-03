#!/usr/bin/env bash
# Install opt-in local git hooks that mirror the CI gate.
#
# Run once per checkout:
#     bash scripts/install-git-hooks.sh
#
# This sets the repo's `core.hooksPath` to scripts/git-hooks/, so any
# developer who runs the installer gets the same commit-message and
# pre-push gates. Without this, the workflow at .github/workflows/ci.yml
# is the only line of defense for code — and CI catches regressions only
# after they land on a branch. The local hooks catch issues before commit
# or push.
#
# Uninstall:
#     git config --unset core.hooksPath
set -euo pipefail

REPO=$(git rev-parse --show-toplevel)
cd "$REPO"

mkdir -p scripts/git-hooks
git config core.hooksPath scripts/git-hooks

cat >scripts/git-hooks/pre-push <<'HOOK'
#!/usr/bin/env bash
# Pre-push gate — runs the same `pnpm check` CI runs. Bypass with
# `git push --no-verify` if you really mean to push a red branch.
set -euo pipefail
echo "→ pre-push: running pnpm check (build/typecheck/lint/guards/test)"
echo "  bypass with: git push --no-verify"
pnpm check
HOOK
chmod +x scripts/git-hooks/pre-push
chmod +x scripts/git-hooks/commit-msg

echo "✓ git hooks installed at scripts/git-hooks/ (core.hooksPath set)"
echo "  commit-msg will validate conventional, descriptive commit messages."
echo "  pre-push will run \`pnpm check\` before every push."
echo "  bypass with: git commit --no-verify or git push --no-verify"
