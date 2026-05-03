export const HELP_TEXT = `skelm — agentic and deterministic workflows in TypeScript

Usage:
  skelm run <workflow.ts> [flags]
  skelm --version
  skelm --help

Run flags:
  --input <json>          Input JSON (single argument)
  --input-file <path>     Input from a file
  --input-stdin           Read input JSON from stdin

Notes:
  * stdout receives the workflow's final output as JSON.
  * stderr receives human progress lines.
  * Exit codes:
      0 ok | 1 cli error | 2 schema validation | 3 run failed
      4 cancelled | 5 wait timeout | 6 permission denied
`
