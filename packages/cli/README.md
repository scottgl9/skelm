# @skelm/cli

> Command-line interface and programmatic CLI primitives for [skelm](https://github.com/scottgl9/skelm).

[![npm](https://img.shields.io/npm/v/@skelm/cli)](https://www.npmjs.com/package/@skelm/cli)

Part of [skelm](https://github.com/scottgl9/skelm).

This package owns the `skelm` bin and the `runCommand` / `parseArgv` / `main` primitives that the bin composes. Both the published [`skelm`](https://www.npmjs.com/package/skelm) meta package and direct workspace consumers use the same `main(argv, io)` entry point — tests can drive the CLI without spawning a subprocess.

## Architecture

As of v0.5, the CLI dispatches every non-exempt command (`run`, `list`, `describe`, `history`, `audit`, `workspace`, `secrets`) to a local **gateway** process over HTTP. The CLI no longer constructs `Runner`, `EventBus`, `SqliteRunStore`, `WorkspaceManager`, `ChainAuditWriter`, `FileSecretResolver`, or the skill registry in-process — the gateway is the single execution surface and trust boundary.

Exempt commands (still work with no gateway running): `help`, `version`, `gateway *`, `init`, `validate`.

When a non-exempt command runs with no gateway live, the CLI auto-starts one. If the platform's service manager has the unit installed (`systemctl --user start skelm-gateway` on linux, `launchctl kickstart` on macOS) it delegates; otherwise it spawns `skelm gateway start` detached and prints a one-time hint suggesting `skelm gateway install --systemd` (linux) or `--launchd` (macOS) for a supervised service.

Opt out of auto-start with `SKELM_NO_AUTOSTART=1` (the CLI then exits non-zero with an actionable message). In CI auto-spawn is refused unless `SKELM_AUTOSTART_IN_CI=1`.

## Install

End users install the [`skelm`](https://www.npmjs.com/package/skelm) meta package, which ships the same bin:

```bash
npm install -g skelm
skelm --help
```

`@skelm/cli` is exported separately so framework integrators (the gateway, in-process embedders, IDE extensions) can reuse the parser and command implementations:

```bash
npm install @skelm/cli
```

## Commands

```
skelm init [dir]                      Scaffold a new project
skelm run <workflow.ts>               Run a workflow once
skelm validate <workflow.ts>          Type-check a workflow without running it
skelm describe <workflow.ts>          Print the workflow's step graph
skelm history                         List recent runs
skelm schedule add <workflow.ts>      Register a trigger (cron / webhook / interval / poll)
skelm schedule list                   List active schedules
skelm schedule stop <id>              Stop a schedule
skelm secrets get <name>              Read a secret from the configured driver
skelm secrets set <name>              Write a secret
skelm audit query                     Query the hash-chained audit log
skelm approvals list                  List pending approval requests
skelm approvals approve <id>          Approve a suspended step
skelm approvals deny <id>             Deny a suspended step
skelm logs                            Tail gateway logs
skelm gateway start                   Run the gateway (foreground; Ctrl-C drains and exits)
skelm gateway status                  Inspect a running gateway
skelm gateway stop                    Stop a running gateway
skelm gateway install --systemd       Install a user-level systemd unit (linux)
skelm gateway install --launchd       Install a user-level launchd LaunchAgent (macOS)
skelm --version
skelm --help
```

`skelm run` flags:

```
--input <json>          Input JSON (single argument)
--input-file <path>     Input from a file
--input-stdin           Read input JSON from stdin
--events <fmt>          human (default) | json | none
```

## Exit codes

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| `0`  | run completed                                              |
| `1`  | uncaught CLI error (bad args, file not found)              |
| `2`  | schema validation failure (input or output)                |
| `3`  | workflow run failed (any step failed)                      |
| `4`  | run was cancelled (SIGINT)                                 |
| `5`  | wait() timed out                                           |
| `6`  | security policy violation (denied tool, exec, network, fs) |
| `7`  | step timed out (`timeoutMs` exceeded)                      |

stdout receives the workflow's final output as JSON. Everything else (progress, JSON events when `--events json`, error messages, prompts) goes to stderr — making `skelm run foo.ts > result.json 2> events.log` work without a parser.

## Programmatic use

```ts
import { main, EXIT } from '@skelm/cli'

const result = await main(['run', './my.workflow.mts'], {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin:  process.stdin,
})
process.exit(result.exitCode)
```

## Stability

`0.x` — APIs may change between minor versions until v1.

## Contributing

See the [contributing guide](https://github.com/scottgl9/skelm/blob/main/.github/CONTRIBUTING.md).

## License

[MIT](LICENSE)
