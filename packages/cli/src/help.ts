export const HELP_TEXT = `skelm — agentic and deterministic workflows in TypeScript

Usage:
  skelm run <workflow.ts | directory> [flags]
  skelm list [--all] [--json]
  skelm stop <workflow-id> [--cancel-inflight] [--json]
  skelm describe <workflow> [--json | --format mermaid]
  skelm history [--workflow <id>] [--last <n>] [--run <id>] [--events] [--json]
  skelm workspace <list|show|clean> [args]
  skelm gateway <start|stop|pause|resume|reload|status|install|uninstall> [flags]
  skelm audit query [flags]
  skelm secrets <get|set|list> [args]
  skelm debug <breakpoints|add|remove|runs|release> [args]
  skelm sessions <list|prune> [--expired] [--older-than-ms <ms>] [--json]
  skelm schedule <add|list|stop|fire> [args]
  skelm tasks <list|get|cancel|retry> [args]
  skelm lineage <run-id> [--json]
  skelm validate <pipeline.ts> [--json]
  skelm logs [--lines <n>] [--since <iso>] [--level <lvl>] [--filter <s>] [--json]
  skelm init [<dir>] [--force]
  skelm builder [<dir>] [--force]
  skelm dashboard <init|start> [<dir>] [flags]
  skelm package <install|list|info|remove|update> [args]
  skelm --version
  skelm --help

Run flags:
  --input <json>          Input JSON (single argument)
  --input-file <path>     Input from a file
  --input-stdin           Read input JSON from stdin
  --events <fmt>          human (default) | json | none

List flags:
  --json                  Write discovered workflows as JSON

Describe flags:
  --json                  Write the workflow graph as JSON
  --format <fmt>          human (default) | mermaid

History flags:
  --workflow <id>         Filter runs by workflow id
  --last <n>              Limit results (default: 20)
  --run <id>              Show one run in detail
  --events                When used with --run, write persisted events to stderr
  --json                  Write history output as JSON

Workspace flags:
  skelm workspace list [--json]
  skelm workspace show <workflow-id> <name> [--json]
  skelm workspace clean <workflow-id> <name> --force

Gateway flags:
  skelm gateway start                      Show how to run the gateway (install, or --foreground)
  skelm gateway start --foreground         Run the gateway in this process (Ctrl-C to stop)
  skelm gateway status [--json]            Show running pid / url / state
  skelm gateway stop                       SIGTERM the running gateway
  skelm gateway reload                     SIGHUP the running gateway
  skelm gateway config list [--json]       Print the resolved gateway config (secrets redacted)
  skelm gateway config get <path>          Print one config value by dotted path (e.g. server.port)
  skelm gateway backend list [--json]      List configured backend ids
  skelm gateway install                    Install as a persistent service; auto-detects systemd (linux) / launchd (macOS)
  skelm gateway install   --systemd        Force a systemd user unit (~/.config/systemd/user/skelm-gateway.service)
  skelm gateway install   --launchd        Force a launchd agent (~/Library/LaunchAgents/com.skelm.gateway.plist)
  skelm gateway uninstall                  Remove the installed service (same auto-detect; --systemd / --launchd to force)
  (pause|resume require the HTTP control surface — POST /gateway/pause|resume)

Approvals config flags:
  skelm approvals config show [--json]                Print the current effective policy
  skelm approvals config validate [--json]            Static-check the policy file
  skelm approvals config set <key> <value>            Set defaultTimeoutMs or stepKindsRequiringApproval
  skelm approvals config approvers add|remove <id>    Manage the approver registry
  (Reads / writes $SKELM_APPROVALS_CONFIG, defaulting to ~/.skelm/approvals.config.json)

Audit flags:
  skelm audit query [--run <runId>] [--actor <name>] [--action <type>]
                      [--since <ISO8601>] [--until <ISO8601>] [--limit <n>]
                      [--before <seq>] [--json]

Secrets flags:
  skelm secrets list [--json]
  skelm secrets get <name> [--json]
  skelm secrets set <name> --value <value> [--json]

Debug flags:
  skelm debug breakpoints [--json]              List active step-id breakpoints
  skelm debug add <stepId>                      Add a breakpoint at a step id
  skelm debug remove <stepId>                   Remove a breakpoint
  skelm debug runs [--json]                     List runs paused at a breakpoint
  skelm debug release <runId>                   Release a paused run

Sessions flags:
  skelm sessions list [--json]                  List ACP sessions tracked by the gateway
  skelm sessions prune [--expired] [--older-than-ms <ms>] [--json]
                                                Drop sessions matching either filter

Schedule flags:
  skelm schedule list [--json]                  List registered schedules
  skelm schedule add <workflow-id> [--id <id>] [--json]
    --cron <expr>           Cron expression (e.g. '*/5 * * * *')
    --tz <zone>             IANA tz for --cron (e.g. America/Chicago)
    --every <dur>           Interval duration: 30s, 15m, 2h, 1d, 500ms
    --every-ms <ms>         Interval in milliseconds (raw)
    --webhook <path>        Webhook path (e.g. /my-hook)
    --at <iso8601>          Fire once at a specific time
    --input <json>          Input JSON passed to the workflow run
    --overlap skip|queue|cancel  Overlap policy (default: skip)
  skelm schedule stop <id> [--json]             Unregister a schedule
  skelm schedule fire <id> [--json]             Manually fire a schedule now

Validate flags:
  skelm validate <pipeline.ts>             Static workflow + permission preflight
    --json                                 Emit issues as JSON
  Exits 0 when the pipeline is clean, 2 (schema validation) when issues are
  found, 1 only for CLI-level argv errors. See exit codes below.

Logs flags:
  --lines <n>             Print only the last N lines
  --since <iso>           Drop entries strictly older than this ISO-8601 timestamp
  --level <lvl>           Minimum level: debug | info | warn | error (default debug)
  --filter <substring>    Substring filter applied to the rendered line
  --json                  Emit raw JSON-Lines (still respects filters)
  (Reads $SKELM_GATEWAY_LOG, defaulting to ~/.skelm/gateway.log)

Init flags:
  --force                 Allow scaffolding into a non-empty directory

Notes:
  * stdout receives the workflow's final output as JSON.
  * stderr receives human progress lines.
  * Exit codes:
      0 ok | 1 cli error | 2 schema validation | 3 run failed
      4 cancelled | 5 wait timeout | 6 permission denied | 7 step timed out
`

const SUBCOMMAND_USAGE: Record<string, string> = {
  run: `Usage:
  skelm run <workflow.ts> [flags]

Run flags:
  --input <json>          Input JSON (single argument)
  --input-file <path>     Input from a file
  --input-stdin           Read input JSON from stdin
  --events <fmt>          human (default) | json | none
`,
  init: `Usage:
  skelm init [<dir>] [--force]

Init flags:
  --force                 Allow scaffolding into a non-empty directory

Dashboard flags:
  skelm dashboard init [<dir>] [--force]        Scaffold a maintained operations dashboard
  skelm dashboard start [<dir>] [--host <h>] [--port <p>]
    --gateway-url <url>                         Gateway URL (default http://127.0.0.1:14738)
    --token <token>                             Bearer token for gateway auth
`,
  builder: `Usage:
  skelm builder [<dir>] [--force]

Scaffold a conversational workflow-builder project (default dir: builder) and
drop into its terminal chat UI. Re-running is idempotent: it reuses an existing
project. Install dependencies once (npm install) before the chat UI launches.
The agent backend defaults to codex and falls over to the in-process Pi
backend (override with SKELM_BUILDER_BACKEND=codex|pi).

Builder flags:
  --force                 Allow scaffolding into a non-empty directory
`,
  dashboard: `Usage:
  skelm dashboard init [<dir>] [--force]
  skelm dashboard start [<dir>] [--host <h>] [--port <p>] [--gateway-url <url>] [--token <token>]

Dashboard flags:
  --force                 Allow scaffolding into a non-empty directory
  --host <host>           Bind host for the local dashboard server
  --port <port>           Bind port for the local dashboard server
  --gateway-url <url>     Gateway URL (default http://127.0.0.1:14738)
  --token <token>         Bearer token for gateways using auth.mode='bearer'
`,
  list: `Usage:
  skelm list [--all] [--json]

List flags:
  --all                   List discovered pipelines instead of the running view
  --json                  Write the listing as JSON
`,
  stop: `Usage:
  skelm stop <workflow-id> [--cancel-inflight] [--json]

Stop flags:
  --cancel-inflight       Also cancel the workflow's in-flight turns
  --json                  Write the result as JSON

Deactivates a workflow on the gateway (unregisters its triggers; sessions are
kept). Distinct from \`skelm gateway stop\`, which stops the whole gateway.
`,
  describe: `Usage:
  skelm describe <workflow> [--json | --format mermaid]

Describe flags:
  --json                  Write the workflow graph as JSON
  --format <fmt>          human (default) | mermaid
`,
  history: `Usage:
  skelm history [--workflow <id>] [--last <n>] [--run <id>] [--events] [--json]

History flags:
  --workflow <id>         Filter runs by workflow id
  --last <n>              Limit results (default: 20)
  --run <id>              Show one run in detail
  --events                When used with --run, write persisted events to stderr
  --json                  Write history output as JSON
`,
  workspace: `Usage:
  skelm workspace <list|show|clean> [args]

Workspace flags:
  skelm workspace list [--json]
  skelm workspace show <workflow-id> <name> [--json]
  skelm workspace clean <workflow-id> <name> --force
`,
  gateway: `Usage:
  skelm gateway <start|stop|pause|resume|reload|status|install|uninstall> [flags]

Gateway flags:
  skelm gateway start                      Show how to run the gateway (install, or --foreground)
  skelm gateway start --foreground         Run the gateway in this process (Ctrl-C to stop)
  skelm gateway status [--json]            Show running pid / url / state
  skelm gateway stop                       SIGTERM the running gateway
  skelm gateway reload                     SIGHUP the running gateway
  skelm gateway config list [--json]       Print the resolved gateway config (secrets redacted)
  skelm gateway config get <path>          Print one config value by dotted path (e.g. server.port)
  skelm gateway backend list [--json]      List configured backend ids
  skelm gateway install                    Install as a persistent service; auto-detects systemd (linux) / launchd (macOS)
  skelm gateway install   --systemd        Force a systemd user unit (~/.config/systemd/user/skelm-gateway.service)
  skelm gateway install   --launchd        Force a launchd agent (~/Library/LaunchAgents/com.skelm.gateway.plist)
  skelm gateway uninstall                  Remove the installed service (same auto-detect; --systemd / --launchd to force)
  (pause|resume require the HTTP control surface — POST /gateway/pause|resume)
`,
  approvals: `Usage:
  skelm approvals <list|approve|deny|config> [args]

Approvals config flags:
  skelm approvals config show [--json]                Print the current effective policy
  skelm approvals config validate [--json]            Static-check the policy file
  skelm approvals config set <key> <value>            Set defaultTimeoutMs or stepKindsRequiringApproval
  skelm approvals config approvers add|remove <id>    Manage the approver registry
  (Reads / writes $SKELM_APPROVALS_CONFIG, defaulting to ~/.skelm/approvals.config.json)
`,
  audit: `Usage:
  skelm audit <query|export|prune> [flags]

Audit flags:
  skelm audit query [--run <runId>] [--actor <name>] [--action <type>]
                    [--since <ISO8601>] [--until <ISO8601>] [--limit <n>]
                    [--before <seq>] [--json]
  skelm audit export [--format jsonl|csv] [--run <runId>] [--actor <name>]
                     [--action <type>] [--since <ISO8601>] [--until <ISO8601>]
                     [--before <seq>] [--out <file>]
                     Stream the filtered log (default jsonl) to stdout or --out.
  skelm audit prune --before <seq> --confirm [--json]
                     Archive entries with seq <= before to a sibling segment and
                     rewrite the live log to the retained tail. Destructive:
                     refuses without --confirm. The archived head and retained
                     tail verify separately, not as one chain.
`,
  secrets: `Usage:
  skelm secrets <get|set|list> [args]

Secrets flags:
  skelm secrets list [--json]              List secret names (no values).
  skelm secrets get <name> [--json]        Existence check — never returns the value.
                                           Exits 0 if set, 1 if not set.
                                           For the value itself, use it from inside a
                                           workflow; the gateway never serializes
                                           plaintext over HTTP.
  skelm secrets set <name> --value <v>     Set or overwrite a secret value.
`,
  debug: `Usage:
  skelm debug <breakpoints|add|remove|runs|release> [args]

Debug flags:
  skelm debug breakpoints [--json]              List active step-id breakpoints
  skelm debug add <stepId>                      Add a breakpoint at a step id
  skelm debug remove <stepId>                   Remove a breakpoint
  skelm debug runs [--json]                     List runs paused at a breakpoint
  skelm debug release <runId>                   Release a paused run
`,
  sessions: `Usage:
  skelm sessions <list|prune> [--expired] [--older-than-ms <ms>] [--json]

Sessions flags:
  skelm sessions list [--json]                  List ACP sessions tracked by the gateway
  skelm sessions prune [--expired] [--older-than-ms <ms>] [--json]
                                                Drop sessions matching either filter
`,
  schedule: `Usage:
  skelm schedule <add|list|stop|fire> [args]

Schedule flags:
  skelm schedule list [--json]                  List registered schedules
  skelm schedule add <workflow-id> [--id <id>] [--json]
    --cron <expr>           Cron expression (e.g. '*/5 * * * *')
    --tz <zone>             IANA tz for --cron (e.g. America/Chicago)
    --every <dur>           Interval duration: 30s, 15m, 2h, 1d, 500ms
    --every-ms <ms>         Interval in milliseconds (raw)
    --webhook <path>        Webhook path (e.g. /my-hook)
    --at <iso8601>          Fire once at a specific time
    --input <json>          Input JSON passed to the workflow run
    --overlap skip|queue|cancel  Overlap policy (default: skip)
  skelm schedule stop <id> [--json]             Unregister a schedule
  skelm schedule fire <id> [--json]             Manually fire a schedule now
`,
  tasks: `Usage:
  skelm tasks <list|get|cancel|retry> [args]

Tasks flags:
  skelm tasks list [--status <s>] [--parent <run-id>] [--json]
    --status <s>            Filter by status: pending|running|completed|failed|cancelled
    --parent <run-id>       Filter by parent run id
  skelm tasks get <task-id> [--json]            Show one task record
  skelm tasks cancel <task-id> [--json]         Cancel a task and its child run
  skelm tasks retry <task-id> [--json]          Re-dispatch a failed/cancelled task
`,
  lineage: `Usage:
  skelm lineage <run-id> [--json]

Lineage flags:
  skelm lineage <run-id>                        Show a run's ancestors + descendants
    --json                                       Emit the lineage tree as JSON
`,
  validate: `Usage:
  skelm validate <pipeline.ts> [--json]

Validate flags:
  skelm validate <pipeline.ts>             Static workflow + permission preflight
    --json                                 Emit issues as JSON
  Exits 0 when the pipeline is clean, 2 (schema validation) when issues are
  found, 1 only for CLI-level argv errors. See exit codes below.
`,
  package: `Usage:
  skelm package <install|list|info|remove|update> [args]

Package flags:
  skelm package install <dir | .tgz>            Install a workflow package from a local source
  skelm package list [--json]                   List installed packages
  skelm package info <name> [--json]            Show manifest, versions, integrity, source
  skelm package remove <name> [--version <v>]   Remove a package (or one version)
  skelm package update <name>                   Reinstall from the recorded lockfile source
  Run an installed package with: skelm run @scope/name[@version][/entry]
`,
  logs: `Usage:
  skelm logs [--lines <n>] [--since <iso>] [--level <lvl>] [--filter <s>] [--json]

Logs flags:
  --lines <n>             Print only the last N lines
  --since <iso>           Drop entries strictly older than this ISO-8601 timestamp
  --level <lvl>           Minimum level: debug | info | warn | error (default debug)
  --filter <substring>    Substring filter applied to the rendered line
  --json                  Emit raw JSON-Lines (still respects filters)
  (Reads $SKELM_GATEWAY_LOG, defaulting to ~/.skelm/gateway.log)
`,
}

export function getHelpText(command?: string): string {
  if (command === undefined) {
    return HELP_TEXT
  }
  return SUBCOMMAND_USAGE[command] ?? HELP_TEXT
}
