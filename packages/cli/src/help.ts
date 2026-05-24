export const HELP_TEXT = `skelm — agentic and deterministic workflows in TypeScript

Usage:
  skelm run <workflow.ts> [flags]
  skelm mcp serve [workflow.mts...]
  skelm list [--json]
  skelm describe <workflow> [--json | --format mermaid]
  skelm history [--workflow <id>] [--last <n>] [--run <id>] [--events] [--json]
  skelm workspace <list|show|clean> [args]
  skelm gateway <start|stop|pause|resume|reload|status|install|uninstall> [flags]
  skelm audit query [flags]
  skelm secrets <get|set|list> [args]
  skelm debug <breakpoints|add|remove|runs|release> [args]
  skelm sessions <list|prune> [--expired] [--older-than-ms <ms>] [--json]
  skelm schedule <add|list|stop|fire> [args]
  skelm acp serve
  skelm validate <pipeline.ts> [--json]
  skelm logs [--lines <n>] [--since <iso>] [--level <lvl>] [--filter <s>] [--json]
  skelm init [<dir>] [--force]
  skelm --version
  skelm --help

Run flags:
  --input <json>          Input JSON (single argument)
  --input-file <path>     Input from a file
  --input-stdin           Read input JSON from stdin
  --events <fmt>          human (default) | json | none

MCP flags:
  skelm mcp serve [workflow.mts...]
    --port <n>            Reserved for a future transport; stdio only in this release

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
  skelm gateway start --foreground         Run the gateway in this process
  skelm gateway status [--json]            Show running pid / url / state
  skelm gateway stop                       SIGTERM the running gateway
  skelm gateway reload                     SIGHUP the running gateway
  skelm gateway install   --systemd        Write ~/.config/systemd/user/skelm-gateway.service
  skelm gateway uninstall --systemd        Remove the systemd unit file
  (pause|resume require the HTTP control surface — POST /gateway/pause|resume)

Approvals config flags:
  skelm approvals config show [--json]                Print the current effective policy
  skelm approvals config validate [--json]            Static-check the policy file
  skelm approvals config set <key> <value>            Set defaultTimeoutMs or stepKindsRequiringApproval
  skelm approvals config approvers add|remove <id>    Manage the approver registry
  (Reads / writes $SKELM_APPROVALS_CONFIG, defaulting to ~/.skelm/approvals.config.json)

Audit flags:
  skelm audit query [--run <runId>] [--actor <name>] [--action <type>]
                      [--since <ISO8601>] [--until <ISO8601>] [--limit <n>] [--json]

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

Acp flags:
  skelm acp serve                               Not yet implemented (reserved for M4)

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
`,
  list: `Usage:
  skelm list [--json]

List flags:
  --json                  Write discovered workflows as JSON
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
  skelm gateway start --foreground         Run the gateway in this process
  skelm gateway status [--json]            Show running pid / url / state
  skelm gateway stop                       SIGTERM the running gateway
  skelm gateway reload                     SIGHUP the running gateway
  skelm gateway install   --systemd        Write ~/.config/systemd/user/skelm-gateway.service
  skelm gateway uninstall --systemd        Remove the systemd unit file
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
  skelm audit query [flags]

Audit flags:
  skelm audit query [--run <runId>] [--actor <name>] [--action <type>]
                    [--since <ISO8601>] [--until <ISO8601>] [--limit <n>] [--json]
`,
  secrets: `Usage:
  skelm secrets <get|set|list> [args]

Secrets flags:
  skelm secrets list [--json]
  skelm secrets get <name> [--json]
  skelm secrets set <name> --value <value> [--json]
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
  acp: `Usage:
  skelm acp serve

Acp flags:
  skelm acp serve                               Not yet implemented (reserved for M4)
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
  validate: `Usage:
  skelm validate <pipeline.ts> [--json]

Validate flags:
  skelm validate <pipeline.ts>             Static workflow + permission preflight
    --json                                 Emit issues as JSON
  Exits 0 when the pipeline is clean, 2 (schema validation) when issues are
  found, 1 only for CLI-level argv errors. See exit codes below.
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
