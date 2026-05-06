# Public API reference

The public surface of each skelm package is locked by baselines in
[`scripts/guards/baselines/`](../../scripts/guards/baselines). Those files are
the source of truth — this page indexes them.

A `pnpm guards` run regenerates each baseline and fails CI if a public export
is added or removed without an explicit baseline update. That gate is what
keeps the API page honest.

## Packages

| Package              | Baseline                                                 | Description                                          |
| -------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| `@skelm/core`        | [`core.txt`](../../scripts/guards/baselines/core.txt)         | Pipelines, builders, runner, types, contexts        |
| `@skelm/cli`         | [`cli.txt`](../../scripts/guards/baselines/cli.txt)           | CLI entry points and argv plumbing                  |
| `@skelm/gateway`     | [`gateway.txt`](../../scripts/guards/baselines/gateway.txt)   | Gateway runtime, audit/secrets/approvals enforcement|
| `@skelm/integrations`| [`integrations.txt`](../../scripts/guards/baselines/integrations.txt) | First-party connectors                       |
| `@skelm/metrics`     | [`metrics.txt`](../../scripts/guards/baselines/metrics.txt)   | Metrics adapters                                    |
| `@skelm/opencode`    | [`opencode.txt`](../../scripts/guards/baselines/opencode.txt) | OpenCode adapter                                   |
| `@skelm/otel`        | [`otel.txt`](../../scripts/guards/baselines/otel.txt)         | OpenTelemetry adapter                              |
| `@skelm/pi`          | [`pi.txt`](../../scripts/guards/baselines/pi.txt)             | Pi backend                                         |
| `@skelm/scheduler`   | [`scheduler.txt`](../../scripts/guards/baselines/scheduler.txt) | Scheduler primitives                              |
| `skelm`              | [`skelm.txt`](../../scripts/guards/baselines/skelm.txt)       | Meta-package re-exports                             |

## Adding a new export

1. Add the export in `packages/<pkg>/src/index.ts`.
2. Run `pnpm build && pnpm guards` — the guard will fail with the diff.
3. Update the relevant baseline file with the new entries.
4. Mention the addition in the package's changelog (see issue #35 for the
   changesets workflow).

## Stability

- Anything in a baseline is part of the public API. Removing or renaming
  requires a major version bump and an entry in the changelog.
- Anything not in a baseline is internal and may move at any time.
