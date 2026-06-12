import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approvalsConfigCommand } from './approvals-config.js'
import { approvalsCommand } from './approvals.js'
import { ArgvParseError, parseArgv } from './argv.js'
import { auditCommand, secretsCommand } from './audit.js'
import { builderCommand } from './builder.js'
import { dashboardCommand } from './dashboard.js'
import { debugCommand } from './debug.js'
import { describeCommand } from './describe.js'
import { EXIT, type ExitCode } from './exit-codes.js'
import { gatewayInspectCommand } from './gateway-inspect.js'
import { gatewayCommand } from './gateway.js'
import { HELP_TEXT, getHelpText } from './help.js'
import { historyCommand } from './history.js'
import { initCommand } from './init.js'
import { listCommand } from './list.js'
import { CliError } from './load-workflow.js'
import { logsCommand } from './logs.js'
import { packageCommand } from './package.js'
import { runCommand } from './run.js'
import { scheduleCommand } from './schedule.js'
import { sessionsCommand } from './sessions.js'
import { stopCommand } from './stop.js'
import { validateCommand } from './validate.js'
import { workspaceCommand } from './workspace.js'

export type { MainIO, MainResult } from './internal/io.js'
import type { MainIO, MainResult } from './internal/io.js'

/**
 * Pure entry point — argv in, IO streams in, exit code out. The `bin.ts`
 * thin shim wires this to process.argv / process.stdout / etc. Tests can
 * call `main` directly without spawning a subprocess.
 */
export async function main(argv: readonly string[], io: MainIO): Promise<MainResult> {
  try {
    const parsed = parseArgv(argv)

    switch (parsed.command) {
      case 'help':
        io.stdout.write(getHelpText(parsed.positional[0]))
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
        const events = enumFlag(parsed.flags.events, 'events', ['human', 'json', 'none'] as const)
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
        const result = await listCommand(
          { json: parsed.flags.json === true, all: parsed.flags.all === true },
          io,
        )
        return { exitCode: result.exitCode }
      }
      case 'stop': {
        const result = await stopCommand(
          {
            ...(typeof parsed.positional[0] === 'string' && { id: parsed.positional[0] }),
            cancelInflight: parsed.flags['cancel-inflight'] === true,
            json: parsed.flags.json === true,
          },
          io,
        )
        return { exitCode: result.exitCode }
      }
      case 'describe': {
        const workflow = parsed.positional[0]
        if (!workflow) {
          io.stderr.write('error: skelm describe requires a workflow id or path\n')
          return { exitCode: EXIT.CLI_ERROR }
        }
        const format = enumFlag(parsed.flags.format, 'format', [
          'human',
          'json',
          'mermaid',
        ] as const)
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
        const last = integerFlag(parsed.flags.last, 'last')
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
        // Read-only config inspection runs locally (no gateway needed), with
        // every secret value redacted. Mutation is deliberately out of scope.
        if (subcommand === 'config' || subcommand === 'backend') {
          const r = await gatewayInspectCommand(
            {
              subcommand,
              ...(typeof parsed.positional[1] === 'string' && { action: parsed.positional[1] }),
              ...(typeof parsed.positional[2] === 'string' && { path: parsed.positional[2] }),
              ...(parsed.flags.json === true && { json: true }),
              ...(typeof parsed.flags['gateway-config'] === 'string' && {
                gatewayConfig: parsed.flags['gateway-config'],
              }),
            },
            io,
          )
          return { exitCode: r.exitCode }
        }
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
            ...(parsed.flags.launchd === true && { launchd: true }),
            ...(typeof parsed.flags['http-port'] === 'string' && {
              httpPort: portFlag(parsed.flags['http-port'], 'http-port'),
            }),
            ...(typeof parsed.flags['http-host'] === 'string' && {
              httpHost: parsed.flags['http-host'],
            }),
            ...(typeof parsed.flags['gateway-config'] === 'string' && {
              gatewayConfig: parsed.flags['gateway-config'],
            }),
          },
          io,
        )
        return { exitCode: result.exitCode }
      }
      case 'approvals': {
        const subcommand = parsed.positional[0]
        if (subcommand === 'config') {
          const action = parsed.positional[1]
          if (action === 'show' || action === 'validate') {
            const r = await approvalsConfigCommand(
              { action, ...(parsed.flags.json === true && { json: true }) },
              io,
            )
            return { exitCode: r.exitCode }
          }
          if (action === 'set') {
            const r = await approvalsConfigCommand(
              {
                action: 'set',
                ...(typeof parsed.positional[2] === 'string' && { key: parsed.positional[2] }),
                ...(typeof parsed.positional[3] === 'string' && { value: parsed.positional[3] }),
                ...(parsed.flags.json === true && { json: true }),
              },
              io,
            )
            return { exitCode: r.exitCode }
          }
          if (action === 'approvers') {
            const op = parsed.positional[2]
            if (op !== 'add' && op !== 'remove') {
              io.stderr.write('error: skelm approvals config approvers requires add | remove\n')
              return { exitCode: EXIT.CLI_ERROR }
            }
            const r = await approvalsConfigCommand(
              {
                action: op === 'add' ? 'approvers-add' : 'approvers-remove',
                ...(typeof parsed.positional[3] === 'string' && {
                  approverId: parsed.positional[3],
                }),
                ...(parsed.flags.json === true && { json: true }),
              },
              io,
            )
            return { exitCode: r.exitCode }
          }
          io.stderr.write(
            'error: skelm approvals config requires show | validate | set | approvers\n',
          )
          return { exitCode: EXIT.CLI_ERROR }
        }
        if (subcommand !== 'list' && subcommand !== 'approve' && subcommand !== 'deny') {
          io.stderr.write('error: approvals requires list, approve, deny, or config\n')
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
      case 'sessions': {
        const sub = parsed.positional[0]
        if (sub !== 'list' && sub !== 'prune') {
          io.stderr.write('error: sessions requires list or prune\n')
          return { exitCode: EXIT.CLI_ERROR }
        }
        const olderThanMs = integerFlag(parsed.flags['older-than-ms'], 'older-than-ms')
        const result = await sessionsCommand(
          {
            subcommand: sub,
            ...(parsed.flags.expired === true && { expired: true }),
            ...(olderThanMs !== undefined && { olderThanMs }),
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
        const limit = integerFlag(parsed.flags.limit, 'limit')
        const before = integerFlag(parsed.flags.before, 'before')
        const result = await auditCommand(
          {
            runId: typeof parsed.flags.run === 'string' ? parsed.flags.run : undefined,
            actor: typeof parsed.flags.actor === 'string' ? parsed.flags.actor : undefined,
            action: typeof parsed.flags.action === 'string' ? parsed.flags.action : undefined,
            since: typeof sinceFlag === 'string' ? sinceFlag : undefined,
            until: typeof untilFlag === 'string' ? untilFlag : undefined,
            ...(limit !== undefined && { limit }),
            ...(before !== undefined && { before }),
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
      case 'builder': {
        const result = await builderCommand(
          {
            ...(typeof parsed.positional[0] === 'string' && { dir: parsed.positional[0] }),
            force: parsed.flags.force === true,
          },
          io,
        )
        return { exitCode: result.exitCode }
      }
      case 'dashboard': {
        const subcommand = parsed.positional[0]
        if (subcommand !== 'init' && subcommand !== 'start') {
          io.stderr.write('error: dashboard requires init or start\n')
          return { exitCode: EXIT.CLI_ERROR }
        }
        const result = await dashboardCommand(
          {
            subcommand,
            ...(typeof parsed.positional[1] === 'string' && { dir: parsed.positional[1] }),
            ...(parsed.flags.force === true && { force: true }),
            ...(typeof parsed.flags.host === 'string' && { host: parsed.flags.host }),
            ...(typeof parsed.flags.port === 'string' && {
              port: portFlag(parsed.flags.port, 'port'),
            }),
            ...(typeof parsed.flags['gateway-url'] === 'string' && {
              gatewayUrl: parsed.flags['gateway-url'],
            }),
            ...(typeof parsed.flags.token === 'string' && { token: parsed.flags.token }),
          },
          io,
        )
        return { exitCode: result.exitCode }
      }
      case 'schedule': {
        const sub = parsed.positional[0]
        if (sub !== 'add' && sub !== 'list' && sub !== 'stop' && sub !== 'fire') {
          io.stderr.write('error: schedule requires add | list | stop | fire\n')
          return { exitCode: EXIT.CLI_ERROR }
        }
        if (sub === 'list') {
          return scheduleCommand({ subcommand: 'list', json: parsed.flags.json === true }, io)
        }
        if (sub === 'stop' || sub === 'fire') {
          const id = parsed.positional[1]
          if (!id) {
            io.stderr.write(`error: skelm schedule ${sub} requires a schedule id\n`)
            return { exitCode: EXIT.CLI_ERROR }
          }
          return scheduleCommand({ subcommand: sub, id, json: parsed.flags.json === true }, io)
        }
        // add
        const workflowId = parsed.positional[1]
        if (!workflowId) {
          io.stderr.write('error: skelm schedule add requires <workflow-id>\n')
          return { exitCode: EXIT.CLI_ERROR }
        }
        const schedId = typeof parsed.flags.id === 'string' ? parsed.flags.id : undefined
        const cron = typeof parsed.flags.cron === 'string' ? parsed.flags.cron : undefined
        const tz = typeof parsed.flags.tz === 'string' ? parsed.flags.tz : undefined
        const everyMs = integerFlag(parsed.flags['every-ms'], 'every-ms')
        const every = typeof parsed.flags.every === 'string' ? parsed.flags.every : undefined
        const webhook = typeof parsed.flags.webhook === 'string' ? parsed.flags.webhook : undefined
        const at = typeof parsed.flags.at === 'string' ? parsed.flags.at : undefined
        const input = typeof parsed.flags.input === 'string' ? parsed.flags.input : undefined
        const overlap = enumFlag(parsed.flags.overlap, 'overlap', [
          'skip',
          'queue',
          'cancel',
        ] as const)
        return scheduleCommand(
          {
            subcommand: 'add',
            workflowId,
            ...(schedId !== undefined && { id: schedId }),
            ...(cron !== undefined && { cron }),
            ...(tz !== undefined && { tz }),
            ...(everyMs !== undefined && { everyMs }),
            ...(every !== undefined && { every }),
            ...(webhook !== undefined && { webhook }),
            ...(at !== undefined && { at }),
            ...(input !== undefined && { input }),
            ...(overlap !== undefined && { overlap }),
            json: parsed.flags.json === true,
          },
          io,
        )
      }
      case 'validate': {
        const path = parsed.positional[0]
        if (!path) {
          io.stderr.write('error: skelm validate requires <pipeline-path>\n')
          return { exitCode: EXIT.CLI_ERROR }
        }
        const result = await validateCommand({ path, json: parsed.flags.json === true }, io)
        return { exitCode: result.exitCode }
      }
      case 'package': {
        const sub = parsed.positional[0]
        if (
          sub !== 'install' &&
          sub !== 'list' &&
          sub !== 'info' &&
          sub !== 'remove' &&
          sub !== 'update'
        ) {
          io.stderr.write('error: package requires install | list | info | remove | update\n')
          return { exitCode: EXIT.CLI_ERROR }
        }
        const result = await packageCommand(
          {
            subcommand: sub,
            ...(typeof parsed.positional[1] === 'string' && { target: parsed.positional[1] }),
            ...(typeof parsed.flags.version === 'string' && { version: parsed.flags.version }),
            ...(parsed.flags.json === true && { json: true }),
          },
          io,
        )
        return { exitCode: result.exitCode }
      }
      case 'logs': {
        const lines = integerFlag(parsed.flags.lines, 'lines')
        const level = enumFlag(parsed.flags.level, 'level', [
          'debug',
          'info',
          'warn',
          'error',
        ] as const)
        const result = await logsCommand(
          {
            ...(lines !== undefined && { lines }),
            ...(typeof parsed.flags.since === 'string' && { since: parsed.flags.since }),
            ...(level !== undefined && { level }),
            ...(typeof parsed.flags.filter === 'string' && { filter: parsed.flags.filter }),
            ...(parsed.flags.json === true && { json: true }),
          },
          io,
        )
        return { exitCode: result.exitCode }
      }
      default: {
        const exhaustive: never = parsed.command
        io.stderr.write(`internal: unhandled command ${exhaustive as string}\n`)
        return { exitCode: EXIT.CLI_ERROR }
      }
    }
  } catch (error) {
    if (error instanceof ArgvParseError) {
      io.stderr.write(`error: ${error.message}\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    if (error instanceof CliError) {
      io.stderr.write(`error: ${error.message}\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    throw error
  }
}

function getVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function integerFlag(value: string, name: string): number
function integerFlag(value: string | boolean | undefined, name: string): number | undefined
function integerFlag(value: string | boolean | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new CliError(`--${name} must be a non-negative integer`, 'argv')
  }
  return Number.parseInt(value, 10)
}

function portFlag(value: string, name: string): number {
  const port = integerFlag(value, name)
  if (port > 65_535) {
    throw new CliError(`--${name} must be between 0 and 65535`, 'argv')
  }
  return port
}

function enumFlag<const T extends readonly string[]>(
  value: string | boolean | undefined,
  name: string,
  allowed: T,
): T[number] | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && allowed.includes(value)) return value
  throw new CliError(`--${name} must be one of: ${allowed.join(', ')}`, 'argv')
}
