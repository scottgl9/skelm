// Public surface of @skelm/cli. The intent is that `skelm gateway` and
// other tooling can import the same command implementations the bin uses.

export { parseArgv } from './argv.js'
export type { ParsedArgv } from './argv.js'
export { EXIT } from './exit-codes.js'
export type { ExitCode } from './exit-codes.js'
export { HELP_TEXT } from './help.js'
export { CliError, loadWorkflowFromFile } from './load-workflow.js'
export type { RunCommandArgs, RunCommandIO, RunCommandResult } from './run.js'
export { runCommand } from './run.js'
export { main } from './main.js'
