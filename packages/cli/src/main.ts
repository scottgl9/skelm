import { approvalsCommand } from './approvals.js'
import { debugCommand } from './debug.js'
import { parseArgv } from './argv.js'
import { auditCommand, secretsCommand } from './audit.js'
import { describeCommand } from './describe.js'
import { EXIT, type ExitCode } from './exit-codes.js'
import { gatewayCommand } from './gateway.js'
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
      case 'gateway': {
        const subcommand = parsed.positional[0]
        const valid = new Set([
          'start',
          'stop',
          'pause',
          'resume',
          'reload',
          'status',
          'install',
          'uninstall',
        ])
        if (subcommand === undefined || !valid.has(subcommand)) {
          io.stderr.write(
            'error: gateway requires one of start, stop, pause, resume, reload, status, install, uninstall\n',
          )
          return { exitCode: EXIT.CLI_ERROR }
        }
        const result = await gatewayCommand(
          {
            subcommand: subcommand as
              | 'start'
              | 'stop'
              | 'pause'
              | 'resume'
              | 'reload'
              | 'status'
              | 'install'
              | 'uninstall',
            ...(parsed.flags.foreground === true && { foreground: true }),
            ...(parsed.flags.detach === true && { detach: true }),
            ...(parsed.flags.json === true && { json: true }),
            ...(parsed.flags.systemd === true && { systemd: true }),
          },
          io,
        )
        return { exitCode: result.exitCode }
      }
      case 'approvals': {
        const subcommand = parsed.positional[0]
        if (subcommand !== 'list' && subcommand !== 'approve' && subcommand !== 'deny') {
          io.stderr.write('error: approvals requires list, approve, or deny\n')
          return { exitCode: EXIT.CLI_ERROR }
        }
        const result = await approvalsCommand(
          {
            subcommand,
            ...(typeof parsed.positional[1] === 'string' && { id: parsed.positional[1] }),
            ...(typeof parsed.flags.reason === 'string' && { reason: parsed.flags.reason }),
            ...(typeof parsed.flags.approver === 'string' && {
              approver: parsed.flags.approver,
            }),
            ...(parsed.flags.json === true && { json: true }),
          },
          io,
        )
        return { exitCode: result.exitCode }
      }
      case 'debug': {
        const sub = parsed.positional[0]
        if (
          sub !== 'breakpoints' &&
          sub !== 'add' &&
          sub !== 'remove' &&
          sub !== 'runs' &&
          sub !== 'release'
        ) {
          io.stderr.write(
            'error: debug requires breakpoints | add <stepId> | remove <stepId> | runs | release <runId>\n',
          )
          return { exitCode: EXIT.CLI_ERROR }
        }
        const result = await debugCommand(
          {
            subcommand: sub,
            ...(typeof parsed.positional[1] === 'string' && { arg: parsed.positional[1] }),
            ...(parsed.flags.json === true && { json: true }),
          },
          io,
        )
        return { exitCode: result.exitCode }
      }
      case 'audit': {
        const subcommand = parsed.positional[0]
        if (subcommand !== 'query') {
          io.stderr.write('error: audit requires query subcommand\n')
          return { exitCode: EXIT.CLI_ERROR }
        }
        const sinceFlag = parsed.flags.since
        const untilFlag = parsed.flags.until
        const limitFlag = parsed.flags.limit
        const result = await auditCommand(
          {
            runId: typeof parsed.flags.run === 'string' ? parsed.flags.run : undefined,
            actor: typeof parsed.flags.actor === 'string' ? parsed.flags.actor : undefined,
            action: typeof parsed.flags.action === 'string' ? parsed.flags.action : undefined,
            since: typeof sinceFlag === 'string' ? sinceFlag : undefined,
            until: typeof untilFlag === 'string' ? untilFlag : undefined,
            limit:
              typeof limitFlag === 'string' && /^\d+$/.test(limitFlag)
                ? Number.parseInt(limitFlag, 10)
                : undefined,
            json: parsed.flags.json === true,
          },
          io,
        )
        return { exitCode: result.exitCode }
      }
      case 'secrets': {
        const subcommand = parsed.positional[0]
        if (
          !subcommand ||
          (subcommand !== 'get' && subcommand !== 'set' && subcommand !== 'list')
        ) {
          io.stderr.write('error: secrets requires get, set, or list subcommand\n')
          return { exitCode: EXIT.CLI_ERROR }
        }
        const result = await secretsCommand(
          {
            command: subcommand as 'get' | 'set' | 'list',
            name: typeof parsed.positional[1] === 'string' ? parsed.positional[1] : undefined,
            value: typeof parsed.flags.value === 'string' ? parsed.flags.value : undefined,
            json: parsed.flags.json === true,
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
  return '0.2.0'
}
