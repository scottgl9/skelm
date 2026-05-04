export const HELP_TEXT = `skelm — agentic and deterministic workflows in TypeScript

Usage:
  skelm run <workflow.ts> [flags]
  skelm list [--json]
  skelm describe <workflow> [--json | --format mermaid]
  skelm history [--workflow <id>] [--last <n>] [--run <id>] [--events] [--json]
  skelm workspace <list|show|clean> [args]
  skelm gateway <start|stop|pause|resume|reload|status|install|uninstall> [flags]
  skelm audit query [flags]
  skelm secrets <get|set|list> [args]
  skelm init [<dir>] [--force]
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
  skelm gateway start --foreground         Run the gateway in this process
  skelm gateway status [--json]            Show running pid / url / state
  skelm gateway stop                       SIGTERM the running gateway
  skelm gateway reload                     SIGHUP the running gateway
  skelm gateway install   --systemd        Write ~/.config/systemd/user/skelm-gateway.service
  skelm gateway uninstall --systemd        Remove the systemd unit file
  (pause|resume require the HTTP control surface — POST /gateway/pause|resume)

Audit flags:
  skelm audit query [--run <runId>] [--actor <name>] [--action <type>]
                      [--since <ISO8601>] [--until <ISO8601>] [--limit <n>] [--json]

Secrets flags:
  skelm secrets list [--json]
  skelm secrets get <name> [--json]
  skelm secrets set <name> --value <value> [--json]

Init flags:
  --force                 Allow scaffolding into a non-empty directory

Notes:
  * stdout receives the workflow's final output as JSON.
  * stderr receives human progress lines.
  * Exit codes:
      0 ok | 1 cli error | 2 schema validation | 3 run failed
      4 cancelled | 5 wait timeout | 6 permission denied
`
