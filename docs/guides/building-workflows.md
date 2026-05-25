# Building Workflows

`skelm run <directory>` runs a workflow project by directory. The CLI resolves
the directory to a single workflow file:

1. A `skelm.config.*` in the directory whose [`entrypoint`](../reference/config.md#entrypoint)
   names the workflow (resolved relative to the config file).
2. Otherwise `index.workflow.{mts,ts}` / `index.pipeline.{mts,ts}`.
3. Otherwise the single `*.workflow.{mts,ts}` / `*.pipeline.{mts,ts}` file, if
   exactly one exists.

Resolution happens client-side; the gateway always receives a concrete file
path, so the thin-client trust boundary is unchanged. See the
[`skelm run` reference](../reference/cli.md).

## The skelm builder

The repo ships `builder/` — a workflow that **authors other workflows** from a
natural-language spec, demonstrating the directory-run convention and the
`agent()` + `wait()` pattern.

```bash
# Start the gateway from builder/ so it loads builder/skelm.config.mts
# (which wires the local LLM backend and declares the entrypoint).
cd builder && OPENAI_MODEL=<your-model> skelm gateway start

# One-shot: pass the spec as input
skelm run builder --input '{"spec":"a workflow that summarizes a GitHub issue"}'

# Interactive: omit --input and answer the wait() prompt
skelm run builder
```

The builder is a normal pipeline:

- A `wait()` step prompts for the spec when `--input` doesn't carry one. The
  gateway emits `run.waiting` and the CLI drives the resume prompt — durable
  human-in-the-loop with no extra TUI.
- An `agent()` step (least-privilege: read the project, write generated files,
  run `skelm`/`node`, no network egress) loads the `skelm` skill, writes the new
  `*.workflow.mts`, and self-checks it with `skelm validate` before returning
  `{ path, summary, permissions }`.

Because the gateway resolves backends from the config it was **started** with, a
project's own backend wiring only applies when the gateway runs with that
config — hence starting the gateway from `builder/`.

See `builder/README.md` in the repository for the full walkthrough.
