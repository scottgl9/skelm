# CLI reference

Canonical reference for the `skelm` CLI. Generated from the in-tree help text
(`packages/cli/src/help.ts`); update this page when you add a subcommand.

## Synopsis

```
skelm <subcommand> [flags]
skelm --version
skelm --help
```

## Exit codes

| Code | Meaning                             |
| ---- | ----------------------------------- |
| 0    | success                             |
| 1    | CLI error (parse, invocation)       |
| 2    | schema validation failure           |
| 3    | run failed at runtime               |
| 4    | run cancelled                       |
| 5    | wait step timed out                 |
| 6    | permission denied                   |
| 7    | step timed out                      |
| 8    | run paused awaiting external resume |
| 9    | backend capability mismatch         |

`stdout` receives the workflow's final output (JSON when present); `stderr`
receives human progress lines unless `--events json` is set, in which case
events stream as JSON-Lines.

## Subcommands

### `skelm run <pipeline.ts | directory>`

Run a pipeline file or workflow project. The CLI dispatches to the gateway over
HTTP, auto-starting a local gateway when allowed and none is already running.
The gateway loads the workflow, type-checks the exported pipeline, enforces
permissions, streams events, and records the run.

| Flag             | Description                                         |
| ---------------- | --------------------------------------------------- |
| `--input <json>` | JSON literal passed as the pipeline input          |
| `--input-file`   | Read input JSON from a file                         |
| `--input-stdin`  | Read input JSON from stdin                          |
| `--events <fmt>` | `human` (default), `json`, or `none`                |

When the argument is a **directory**, `skelm run` behaves one of two ways:

- **Triggered / persistent project** — if the directory's `skelm.config.*`
  declares `triggerSources`, or its entrypoint is a `persistentWorkflow()`, the
  CLI **activates** the project on the gateway (`POST /v1/projects/activate`):
  the gateway imports the config, registers the trigger sources + backends +
  workflow, arms the triggers, and takes ownership. The project's
  `defaults.permissions`, `defaults.permissionProfiles`, and
  `backends.{agent,infer}` are pinned per workflow id — they apply when that
  workflow runs and do not bind another active project's workflows (see
  [Permissions › Per-workflow project
  ceilings](../concepts/permissions.md#per-workflow-project-ceilings)). The CLI
  prints a summary and **exits** — the workflow keeps running on the gateway,
  driven by its triggers. Re-running is an idempotent refresh. A project
  outside the gateway's trusted roots is refused (exit `1`); see
  [activate](./http.md#projects).

- **One-shot pipeline** — otherwise the CLI resolves the directory to a single
  workflow file and runs it inline, waiting for completion, in order:
  1. A `skelm.config.*` `entrypoint` field — see [config](./config.md#entrypoint).
  2. An `index.workflow.{mts,ts}` or `index.pipeline.{mts,ts}`.
  3. The single `*.workflow.{mts,ts}` / `*.pipeline.{mts,ts}` file, if exactly one
     exists.

  If a directory has neither a declared entrypoint nor an unambiguous workflow
  file, `skelm run` exits `1` (CLI error).

```bash
skelm run examples/hello        # resolves the directory to its single workflow file
```

### `skelm list [--all] [--json]`

Print what the gateway is currently running: persistent workflows, their armed
triggers (kind/driver, fire count, last-fired, inflight), session counts, and
in-flight runs. Backed by `GET /v1/active`.

Pass `--all` to instead list the pipelines the gateway has *discovered*
(registry + glob), regardless of whether anything is running. `--json` emits the
raw payload for either view.

### `skelm stop <workflow-id> [--cancel-inflight] [--json]`

Deactivate a workflow on the gateway: unregister its triggers (its queue driver
stops — e.g. Telegram polling halts) and drop its registration so a reload will
not re-arm it. Persisted sessions are kept, so re-running `skelm run <dir>`
resumes the conversation. Pass `--cancel-inflight` to also cancel its running
turns. Exits `1` if the workflow has no live triggers.

This is **not** `skelm gateway stop` (which stops the whole gateway process) nor
`skelm schedule stop <trigger-id>` (which removes a single trigger).

### `skelm describe <pipeline> [--json | --format mermaid]`

Print a structural description of a pipeline (steps, edges, permissions).
`--format mermaid` emits a graph diagram.

### `skelm history`

Inspect run history persisted by the gateway's run store.

```
skelm history [--workflow <id>] [--last <n>] [--run <id>] [--events] [--json]
```

### `skelm workspace <list|show|clean>`

Manage per-pipeline workspace directories the runtime creates under `.skelm/`.

```
skelm workspace list [--json]
skelm workspace show <pipeline-id> <name> [--json]
skelm workspace clean <pipeline-id> <name> --force
```

### `skelm gateway <subcommand>`

Manage the long-running gateway service. The gateway is the trust boundary —
every privileged action is enforced and audited there.

| Subcommand    | Description                                                                  |
| ------------- | ---------------------------------------------------------------------------- |
| `install`     | Write systemd unit, reload, enable, and start the service in the background  |
| `uninstall`   | Stop, disable, and remove the systemd unit                                   |
| `start`       | Start the gateway. Delegates to systemd if installed; foreground otherwise. `--foreground` forces foreground mode. |
| `start --detach` | Start the gateway as a detached background process                        |
| `stop`        | Stop the running gateway (delegates to systemd if the unit is installed)     |
| `reload`      | SIGHUP the running gateway (hot-reload config)                               |
| `status`      | Print pid, url, reachability, and lifecycle state. `--json` available        |

`pause` and `resume` are exposed via the HTTP control surface
(`POST /gateway/pause|resume`); see the [HTTP reference](./http.md).

### `skelm approvals <list|approve|deny|config>`

Inspect and resolve pending approval gates, and manage the approval policy.

```
skelm approvals list [--json]
skelm approvals approve <id> [--reason <text>] [--approver <name>] [--json]
skelm approvals deny    <id> [--reason <text>] [--approver <name>] [--json]
```

Policy management writes the file at `$SKELM_APPROVALS_CONFIG`
(default `~/.skelm/approvals.config.json`, mode `0600`). The gateway re-reads
the file on `skelm gateway reload`.

```
skelm approvals config show     [--json]
skelm approvals config validate [--json]
skelm approvals config set <defaultTimeoutMs|stepKindsRequiringApproval> <value>
skelm approvals config approvers add    <id>
skelm approvals config approvers remove <id>
```

### `skelm audit query`

Query the gateway's append-only audit log.

```
skelm audit query [--run <runId>] [--actor <name>] [--action <type>]
                  [--since <ISO8601>] [--until <ISO8601>] [--limit <n>] [--json]
```

### `skelm secrets <list|get|set>`

Manage secret names through the gateway-mediated resolver. Values never round
through the audit log.

```
skelm secrets list [--json]
skelm secrets get <name> [--json]
skelm secrets set <name> --value <value> [--json]
```

### `skelm debug`

Step-id breakpoints for the runner.

```
skelm debug breakpoints [--json]
skelm debug add <stepId>
skelm debug remove <stepId>
skelm debug runs [--json]
skelm debug release <runId>
```

### `skelm sessions <list|prune>`

ACP session bookkeeping.

```
skelm sessions list [--json]
skelm sessions prune [--expired] [--older-than-ms <ms>] [--json]
```

### `skelm schedule <add|list|stop|fire>`

Register and manage scheduled pipeline runs.

```
skelm schedule add <pipeline-id> [--id <id>] [--json]
  --cron <expr>           Cron expression
  --every-ms <ms>         Interval in milliseconds
  --webhook <path>        Webhook path (e.g. /my-hook)
  --at <iso8601>          Fire once at a specific time
  --input <json>          Input JSON
  --overlap skip|queue|cancel
skelm schedule list [--json]
skelm schedule stop <id> [--json]
skelm schedule fire <id> [--json]
```

### `skelm init [<dir>]`

Scaffold a new skelm project under `<dir>` (defaults to `.`). Creates
`package.json`, `tsconfig.json`, `skelm.config.mts`,
`workflows/hello.workflow.mts`, `.gitignore`, and `README.md`. `--force` allows
scaffolding into a non-empty directory.

### `skelm builder [<dir>]`

Scaffold a **conversational workflow-builder** project under `<dir>` (defaults
to `builder`) and drop into its terminal chat UI. Describe a workflow in plain
language; the agent consults the bundled `skelm` skill, writes a
`*.workflow.mts` into the folder, validates it with `skelm validate`, and
reports the path.

```
skelm builder [<dir>] [--force]
```

The scaffold contains a `persistentWorkflow` (the chat agent), an Ink terminal
frontend over the `tui` chatui transport, the `skelm` skill, and a
`skelm.config.mts`. Behavior:

- **Idempotent.** Re-running reuses an existing builder project (never clobbers
  scaffolded files).
- **No auto-install.** Like `skelm init`, it never installs dependencies. On a
  fresh scaffold it prints the install step and exits; once `node_modules`
  exists it activates the project on the gateway and hosts the chat UI in-process
  (the same path as `skelm run <tui-dir>`).
- **`--force`** allows scaffolding into a non-empty directory.

The agent backend resolves with a runtime fallback (skelm's
`createRoutingBackend`): **codex** by default (auth via `codex login` or
`CODEX_API_KEY`), falling over to the in-process **pi-sdk** backend
(`OPENAI_BASE_URL` / `OPENAI_MODEL`) if a codex turn errors. Set
`SKELM_BUILDER_BACKEND=codex|pi-sdk` to pin one backend and skip the fallback.

### `skelm validate <pipeline.ts>`

Static check that the pipeline imports cleanly and its declared schemas/steps
are well-formed. No runtime side effects.

```
skelm validate <pipeline.ts> [--json]
```

### `skelm logs`

Stream structured logs from a running gateway.

```
skelm logs [--lines <n>] [--since <iso>] [--level <lvl>] [--filter <s>] [--json]
```
