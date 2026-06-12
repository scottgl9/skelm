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

When the argument is a **workflow-package spec** (`@scope/name`,
`@scope/name@1.2.3`, `@scope/name/entry`, or unscoped `name/entry`), `skelm run`
resolves it through the gateway's installed-package store
(`POST /v1/packages/resolve`) to the package's entry file and runs it exactly
like a file. For unscoped forms, a real file or directory path still wins when
it exists on disk. The entry id defaults to `default`. See
[`skelm package`](#skelm-package-installlistinforemoveupdate) and
[workflow packages](./workflow-packages.md).

```bash
skelm run examples/hello        # resolves the directory to its single workflow file
skelm run @skelm/hello          # runs the installed package's `default` workflow
skelm run @skelm/hello/report   # runs the `report` workflow from the package
skelm run hello/report          # runs the `report` workflow from an unscoped package
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
| `config list` | Print the resolved gateway config with secrets redacted (`--json`). Read-only; no running gateway needed. |
| `config get <path>` | Print one config value by dotted path, e.g. `server.port` (redacted). |
| `backend list` | List configured backend ids (`--json`).                                     |

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

Query the gateway's append-only audit log. Returns the most recent entries
(tail) by default; the gateway streams the log so reads stay bounded no matter
how large it grows.

```
skelm audit query [--run <runId>] [--actor <name>] [--action <type>]
                  [--since <ISO8601>] [--until <ISO8601>] [--limit <n>]
                  [--before <seq>] [--json]
```

`--limit` defaults to 500 (max 5000). `--before <seq>` pages backwards: pass the
lowest `seq` from a page to fetch the next-older page.

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

### `skelm tasks <list|get|cancel|retry>`

Inspect and manage detached tasks — workflows spawned as tracked, detached
child runs (see [Tasks & lineage](./http.md#tasks-lineage-v1-tasks-v1-lineage)).
Thin client over `/v1/tasks`.

```
skelm tasks list [--status <s>] [--parent <run-id>] [--json]
  --status <s>            pending|running|completed|failed|cancelled
  --parent <run-id>       Filter by parent run id
skelm tasks get <task-id> [--json]      Show one task record
skelm tasks cancel <task-id> [--json]   Cancel a task and its child run
skelm tasks retry <task-id> [--json]    Re-dispatch a failed/cancelled task
```

`cancel` on an already-terminal task and `retry` on a non-terminal task both
exit non-zero (the gateway returns `409`).

### `skelm lineage <run-id>`

Show a run's ancestors and descendants, reconstructed from task links. Thin
client over `/v1/lineage/:runId`.

```
skelm lineage <run-id> [--json]
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
`CODEX_API_KEY`), falling over to the in-process **Pi** backend
(`OPENAI_BASE_URL` / `OPENAI_MODEL`) if a codex turn errors. Set
`SKELM_BUILDER_BACKEND=codex|pi` to pin one backend and skip the fallback.

### `skelm dashboard <init|start> [<dir>]`

Scaffold and run the local skelm operations dashboard.

```
skelm dashboard init [<dir>] [--force]
skelm dashboard start [<dir>] [--host <host>] [--port <port>]
  --gateway-url <url>
  --token <token>
```

The scaffold defaults to `dashboard`, uses `.mts` TypeScript source, and has no
local dependencies or install step. `start` runs `src/server.mts`, serves the
browser app, and proxies `/api/*` to the configured gateway. For bearer-auth
gateways, pass `--token` or set `SKELM_DASHBOARD_TOKEN`; the token is injected
server-side and is not stored in the browser.

The default dashboard port is `14740`; the default gateway URL is
`http://127.0.0.1:14738`. Port `14739` is reserved for the gateway egress proxy.

### `skelm package <install|list|info|remove|update>`

Manage installed workflow packages. A thin client over the gateway's package
API (`/v1/packages/*`); the store and `skelm.lock.json` are owned by the
gateway. See [workflow packages](./workflow-packages.md) for the format.

```
skelm package install <dir | .tgz>            Install from a local directory or .tgz
skelm package list [--json]                   List installed packages
skelm package info <name> [--json]            Manifest, versions, integrity, source
skelm package remove <name> [--version <v>]   Remove a package (or one version)
skelm package update <name>                   Reinstall from the recorded lockfile source
```

Install accepts a **local directory** or a **local `.tgz` tarball** only; remote
npm-registry installs are planned but not yet supported. The manifest is
validated before any file is copied, and a tarball entry that escapes the
package root (absolute path or `..`) is rejected. Run an installed package with
`skelm run @scope/name[@version][/entry]`.

Exit codes: `0` on success; `1` for a CLI/gateway error (unknown package or
entry, invalid manifest, gateway unreachable).

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
