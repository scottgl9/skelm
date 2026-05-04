# Architectural-invariant guards

This directory is the home for scripts that enforce skelm's architectural invariants in CI. Until each script lands, the corresponding rule lives only in human review.

## Status

| Guard | Rule | Status |
|---|---|---|
| `gateway-only-enforcement.ts` | Privileged actions (exec, network, fs-write, tool dispatch) route through the gateway's enforcement helper. | **Not implemented.** Existing code in `@skelm/core/src/mcp/client.ts` and `@skelm/core/src/acp/client.ts` uses `node:child_process` directly because those are transport implementations. A real guard needs a designed carve-out (allowlist of transport modules + an `@gateway-enforced` annotation convention) before it can fail meaningfully. |
| `default-deny-permissions.ts` | Every field on `AgentPermissions` ships with adversarial fixture coverage under `packages/core/test/security/`. | **Implemented.** Reads the `AgentPermissions` interface, asserts each non-exempt field name appears somewhere in the security corpus. Run via `pnpm guards`. Mechanical check only — fixtures are still reviewed by humans. |
| `changelog-present.ts` | Every behavior-changing PR carries a changeset entry. | **Not implemented.** Requires choosing a changeset tool (e.g. `@changesets/cli`); none is installed. |
| `public-export-baseline.ts` | Public-API changes (`packages/*/src/index.ts` exports) update the baseline file in the same commit. | **Implemented.** Each package's exports captured in `scripts/guards/baselines/<pkg>.txt`. New or removed exports require running `pnpm exec tsx scripts/guards/public-export-baseline.ts --update` and committing the diff. |

## How to land a guard

1. Pick a rule from the table.
2. Add a `<guard-name>.ts` script that exits non-zero on violation, with a message naming the offending file.
3. Wire it into the root `pnpm guards` script (when introduced) and `pnpm check`.
4. Update this table to mark it implemented and link the script.
5. Update `AGENTS.md` / `CLAUDE.md` to reference the working guard rather than "CI enforces" hand-waving.

## Why this README exists

Earlier versions of `AGENTS.md` and `CLAUDE.md` claimed these guards were active in CI. They weren't — the directory didn't exist. This README is the placeholder so the rules stay visible until the scripts catch up.
