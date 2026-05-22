import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approvalsConfigCommand } from './approvals-config.js'
import { approvalsCommand } from './approvals.js'
import { parseArgv } from './argv.js'
import { auditCommand, secretsCommand } from './audit.js'
import { debugCommand } from './debug.js'
import { describeCommand } from './describe.js'
import { EXIT, type ExitCode } from './exit-codes.js'
import { gatewayCommand } from './gateway.js'
import { HELP_TEXT } from './help.js'
import { historyCommand } from './history.js'
import { initCommand } from './init.js'
import { listCommand } from './list.js'
import { CliError } from './load-workflow.js'
import { logsCommand } from './logs.js'
import { mcpServeCommand } from './mcp-serve.js'
import { runCommand } from './run.js'
import { scheduleCommand } from './schedule.js'
import { sessionsCommand } from './sessions.js'
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
      case 'mcp': {
        const sub = parsed.positional[0]
        if (sub !== 'serve') {
          io.stderr.write(
            'error: mcp requires serve subcommand\n  skelm mcp serve [workflow.mts...]\n',
          )
          return { exitCode: EXIT.CLI_ERROR }
        }
        const portFlag = parsed.flags.port
        const port =
          typeof portFlag === 'string' && /^\d+$/.test(portFlag)
            ? Number.parseInt(portFlag, 10)
            : undefined
        const result = await mcpServeCommand(
          {
            workflows: parsed.positional.slice(1),
            ...(port !== undefined ? { port } : {}),
          },
          io,
        )
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
            ...(typeof parsed.flags['http-port'] === 'string' && {
              httpPort: Number(parsed.flags['http-port']),
            }),
            ...(typeof parsed.flags['http-host'] === 'string' && {
              httpHost: parsed.flags['http-host'],
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
        const olderRaw = parsed.flags['older-than-ms']
        const olderThanMs =
          typeof olderRaw === 'string' && /^\d+$/.test(olderRaw)
            ? Number.parseInt(olderRaw, 10)
            : undefined
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
        const everyRaw = parsed.flags['every-ms']
        const schedId = typeof parsed.flags.id === 'string' ? parsed.flags.id : undefined
        const cron = typeof parsed.flags.cron === 'string' ? parsed.flags.cron : undefined
        const tz = typeof parsed.flags.tz === 'string' ? parsed.flags.tz : undefined
        const everyMs =
          typeof everyRaw === 'string' && /^\d+$/.test(everyRaw)
            ? Number.parseInt(everyRaw, 10)
            : undefined
        const every = typeof parsed.flags.every === 'string' ? parsed.flags.every : undefined
        const webhook = typeof parsed.flags.webhook === 'string' ? parsed.flags.webhook : undefined
        const at = typeof parsed.flags.at === 'string' ? parsed.flags.at : undefined
        const input = typeof parsed.flags.input === 'string' ? parsed.flags.input : undefined
        const overlap =
          parsed.flags.overlap === 'skip' ||
          parsed.flags.overlap === 'queue' ||
          parsed.flags.overlap === 'cancel'
            ? parsed.flags.overlap
            : undefined
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
      case 'logs': {
        const linesFlag = parsed.flags.lines
        const lines =
          typeof linesFlag === 'string' && /^\d+$/.test(linesFlag)
            ? Number.parseInt(linesFlag, 10)
            : undefined
        const levelFlag = parsed.flags.level
        const level =
          levelFlag === 'debug' ||
          levelFlag === 'info' ||
          levelFlag === 'warn' ||
          levelFlag === 'error'
            ? levelFlag
            : undefined
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
      case 'acp': {
        // P5.2 — ACP serve placeholder. Reserves the CLI flag namespace for
        // M4. The transport wiring is not yet implemented; exit 1 with a
        // clear message so callers aren't left guessing.
        const sub = parsed.positional[0]
        if (sub !== 'serve') {
          io.stderr.write('error: acp requires serve subcommand\n  skelm acp serve\n')
          return { exitCode: EXIT.CLI_ERROR }
        }
        io.stderr.write('error: skelm acp serve is not yet implemented (reserved for M4)\n')
        return { exitCode: EXIT.CLI_ERROR }
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
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}
