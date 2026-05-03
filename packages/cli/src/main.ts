import { parseArgv } from './argv.js'
import { describeCommand } from './describe.js'
import { EXIT, type ExitCode } from './exit-codes.js'
import { HELP_TEXT } from './help.js'
import { historyCommand } from './history.js'
import { initCommand } from './init.js'
import { listCommand } from './list.js'
import { CliError } from './load-workflow.js'
import { runCommand } from './run.js'
import { workspaceCommand } from './workspace.js'

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

  try {
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
        const eventsFlag = parsed.flags.events
        const events: 'human' | 'json' | 'none' | undefined =
          eventsFlag === 'json' || eventsFlag === 'none' || eventsFlag === 'human'
            ? eventsFlag
            : undefined
        const args = {
          workflowPath,
          ...(typeof parsed.flags.input === 'string' && { input: parsed.flags.input }),
          ...(typeof parsed.flags['input-file'] === 'string' && {
            inputFile: parsed.flags['input-file'],
          }),
          ...(parsed.flags['input-stdin'] === true && { inputStdin: true }),
          ...(events !== undefined && { events }),
        }
        const result = await runCommand(args, io)
        return { exitCode: result.exitCode }
      }
      case 'list': {
        const result = await listCommand({ json: parsed.flags.json === true }, io)
        return { exitCode: result.exitCode }
      }
      case 'describe': {
        const workflow = parsed.positional[0]
        if (!workflow) {
          io.stderr.write('error: skelm describe requires a workflow id or path\n')
          return { exitCode: EXIT.CLI_ERROR }
        }
        const formatFlag = parsed.flags.format
        const format =
          formatFlag === 'human' || formatFlag === 'json' || formatFlag === 'mermaid'
            ? formatFlag
            : undefined
        const result = await describeCommand(
          {
            workflow,
            json: parsed.flags.json === true,
            ...(format !== undefined && { format }),
          },
          io,
        )
        return { exitCode: result.exitCode }
      }
      case 'history': {
        const lastFlag = parsed.flags.last
        const last =
          typeof lastFlag === 'string' && /^\d+$/.test(lastFlag)
            ? Number.parseInt(lastFlag, 10)
            : undefined
        const result = await historyCommand(
          {
            ...(typeof parsed.flags.workflow === 'string' && { workflow: parsed.flags.workflow }),
            ...(last !== undefined && { last }),
            ...(typeof parsed.flags.run === 'string' && { runId: parsed.flags.run }),
            ...(parsed.flags.events === true && { events: true }),
            ...(parsed.flags.json === true && { json: true }),
          },
          io,
        )
        return { exitCode: result.exitCode }
      }
      case 'workspace': {
        const subcommand = parsed.positional[0]
        if (subcommand !== 'list' && subcommand !== 'show' && subcommand !== 'clean') {
          io.stderr.write('error: workspace requires one of list, show, or clean\n')
          return { exitCode: EXIT.CLI_ERROR }
        }
        const result = await workspaceCommand(
          {
            subcommand,
            ...(typeof parsed.positional[1] === 'string' && { workflowId: parsed.positional[1] }),
            ...(typeof parsed.positional[2] === 'string' && { name: parsed.positional[2] }),
            ...(parsed.flags.json === true && { json: true }),
            ...(parsed.flags.force === true && { force: true }),
          },
          io,
        )
        return { exitCode: result.exitCode }
      }
      case 'init': {
        const dir = parsed.positional[0] ?? '.'
        const force = parsed.flags.force === true
        const result = await initCommand({ dir, force }, io)
        return { exitCode: result.exitCode }
      }
      default: {
        const exhaustive: never = parsed.command
        io.stderr.write(`internal: unhandled command ${exhaustive as string}\n`)
        return { exitCode: EXIT.CLI_ERROR }
      }
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr.write(`error: ${error.message}\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    throw error
  }
}

function getVersion(): string {
  // Bumped on release.
  return '0.1.0'
}
