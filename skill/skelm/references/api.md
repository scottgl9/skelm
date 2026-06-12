# API reference

Per-package, generated reference for every public export.

The pages under [`./api/`](./api/) are produced by [TypeDoc](https://typedoc.org/)
from the TSDoc comments in each package's source tree. They are regenerated as
part of `pnpm docs:build` and stay in lockstep with the code they describe.

## Packages

| Package | Source | Reference |
| ------- | ------ | --------- |
| `@skelm/agent` | [`packages/agent`](https://github.com/scottgl9/skelm/tree/main/packages/agent) | [API](./api/@skelm/agent/) |
| `@skelm/cli` | [`packages/cli`](https://github.com/scottgl9/skelm/tree/main/packages/cli) | [API](./api/@skelm/cli/) |
| `@skelm/core` | [`packages/core`](https://github.com/scottgl9/skelm/tree/main/packages/core) | [API](./api/@skelm/core/) |
| `@skelm/gateway` | [`packages/gateway`](https://github.com/scottgl9/skelm/tree/main/packages/gateway) | [API](./api/@skelm/gateway/) |
| `@skelm/integrations` | [`packages/integrations`](https://github.com/scottgl9/skelm/tree/main/packages/integrations) | [API](./api/@skelm/integrations/) |
| `@skelm/metrics` | [`packages/metrics`](https://github.com/scottgl9/skelm/tree/main/packages/metrics) | [API](./api/@skelm/metrics/) |
| `@skelm/opencode` | [`packages/opencode`](https://github.com/scottgl9/skelm/tree/main/packages/opencode) | [API](./api/@skelm/opencode/) |
| `@skelm/otel` | [`packages/otel`](https://github.com/scottgl9/skelm/tree/main/packages/otel) | [API](./api/@skelm/otel/) |
| `@skelm/pi` | [`packages/pi`](https://github.com/scottgl9/skelm/tree/main/packages/pi) | [API](./api/@skelm/pi/) |
| `@skelm/scheduler` | [`packages/scheduler`](https://github.com/scottgl9/skelm/tree/main/packages/scheduler) | [API](./api/@skelm/scheduler/) |
| `@skelm/vercel-ai` | [`packages/vercel-ai`](https://github.com/scottgl9/skelm/tree/main/packages/vercel-ai) | [API](./api/@skelm/vercel-ai/) |
| `skelm` | [`packages/skelm`](https://github.com/scottgl9/skelm/tree/main/packages/skelm) | [API](./api/skelm/) |

## Public-surface contract

What is documented under [`./api/`](./api/) is the public API. The same
surface is locked by machine-checked baselines under
[`scripts/guards/baselines/`](https://github.com/scottgl9/skelm/tree/main/scripts/guards/baselines) — those files
list the exact set of symbols each package exports.

`pnpm guards` regenerates every baseline and fails CI if a public export is
added or removed without an explicit baseline update. That gate, together
with this reference, is what keeps the API contract honest.

### Adding a new export

1. Add the export from `packages/<pkg>/src/index.ts` with a TSDoc comment.
2. Run `pnpm build && pnpm guards` — the guard will fail with the diff.
3. Update the matching `scripts/guards/baselines/<pkg>.txt` entry.
4. Note the addition in [`docs/CHANGELOG.md`](../../../CHANGELOG.md).
5. Rebuild docs: `pnpm --filter @skelm/docs docs:build` (TypeDoc picks up
   the new symbol automatically).

### Stability

- Anything in a baseline (and therefore on a TypeDoc page) is part of the
  public API. Removing or renaming requires a major version bump and an
  entry in the changelog.
- Anything not in a baseline is internal and may move at any time.
