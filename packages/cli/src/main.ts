import { parseArgv } from './argv.js'
import { EXIT, type ExitCode } from './exit-codes.js'
import { HELP_TEXT } from './help.js'
import { runCommand } from './run.js'

export interface MainIO {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  stdin: NodeJS.ReadableStream
}

export interface MainResult {
  exitCode: ExitCode
}

/**
 * Pure entry point — argv in, IO streams in, exit code out. The `bin.ts`
 * thin shim wires this to process.argv / process.stdout / etc. Tests can
 * call `main` directly without spawning a subprocess.
 */
export async function main(argv: readonly string[], io: MainIO): Promise<MainResult> {
  const parsed = parseArgv(argv)

  switch (parsed.command) {
    case 'help':
      io.stdout.write(HELP_TEXT)
      return { exitCode: EXIT.OK }
    case 'version':
      io.stdout.write(`${getVersion()}\n`)
      return { exitCode: EXIT.OK }
    case 'unknown':
      io.stderr.write(`unknown command: ${parsed.positional[0]}\n${HELP_TEXT}`)
      return { exitCode: EXIT.CLI_ERROR }
    case 'run': {
      const workflowPath = parsed.positional[0]
      if (!workflowPath) {
        io.stderr.write('error: skelm run requires a workflow file path\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
      const args = {
        workflowPath,
        ...(typeof parsed.flags.input === 'string' && { input: parsed.flags.input }),
        ...(typeof parsed.flags['input-file'] === 'string' && {
          inputFile: parsed.flags['input-file'],
        }),
        ...(parsed.flags['input-stdin'] === true && { inputStdin: true }),
      }
      const result = await runCommand(args, io)
      return { exitCode: result.exitCode }
    }
    default: {
      const exhaustive: never = parsed.command
      io.stderr.write(`internal: unhandled command ${exhaustive as string}\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
  }
}

function getVersion(): string {
  // Bumped on release.
  return '0.0.0'
}
