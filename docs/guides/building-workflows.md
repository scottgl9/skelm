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

The repo ships `builder/` — a conversational agent that **authors workflows**
for you. It is a [persistent workflow](../recipes/chatui-persistent-workflow.md)
over a terminal chat UI, launched with the [`skelm builder`](../reference/cli.md#skelm-builder-dir)
command rather than `skelm run`:

```bash
skelm builder      # scaffolds ./builder if needed, then drops into the chat UI
```

Each turn you describe a workflow in natural language; the agent consults the
bundled `skelm` skill, writes a `*.workflow.mts` into the project, validates it
with `skelm validate`, and reports the path. The agent runs under explicitly
declared, least-privilege grants (read the project, write generated files, run
`skelm`/`node`, load the `skelm` skill). Its backend resolves from
`builder/skelm.config.mts` — codex by default, with an in-process pi-sdk
failover.

See `builder/README.md` in the repository for the full walkthrough.
