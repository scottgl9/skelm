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

`skelm builder` scaffolds and runs a conversational workflow-builder project. It
is a [persistent workflow](../concepts/persistent-workflows.md) driven by the
terminal `tui` chat transport: each chat turn fires through the gateway, the
agent authors or edits a `*.workflow.mts`, runs `skelm validate`, and replies
with the file path.

```bash
skelm builder        # first run: scaffold ./builder and print next steps
cd builder
npm install
skelm builder        # later runs: activate the project and open the chat UI
```

The command is idempotent. If the target already contains both
`builder.workflow.mts` and `skelm.config.mts`, it reuses that project rather
than overwriting it. Pass `--force` only when you intentionally want to refresh
the scaffolded templates and bundled skill.

The scaffold contains:

- `builder.workflow.mts` — the `persistentWorkflow` chat agent.
- `chatui-frontend.mts` — the Ink terminal frontend used by the `tui` transport.
- `skelm.config.mts` — a routing backend and the permission ceiling needed for
  persistent turns.
- `skills/skelm/SKILL.md` — the authoring reference the agent is allowed to
  load.

The backend resolves from `skelm.config.mts`: Codex is the default
(`codex login` or `CODEX_API_KEY`), with an in-process Pi failover pointed
at `OPENAI_BASE_URL` / `OPENAI_MODEL`. Set
`SKELM_BUILDER_BACKEND=codex|pi` to pin one backend and skip failover.

The builder runs under explicit grants, not an unrestricted bypass: read the
project, write generated workflow files, run `skelm` / `node` / `bash`, load the
`skelm` skill, and reach its configured backend. `skelm builder` activates this
project on the gateway and hosts the terminal UI in the CLI process; you do not
start it with `skelm run builder` or a manual `wait()` prompt.

See `builder/README.md` in the repository for the scaffold-local reference.
