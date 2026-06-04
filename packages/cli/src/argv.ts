import { Command } from 'commander'

const COMMANDS = [
  'run',
  'init',
  'list',
  'stop',
  'describe',
  'history',
  'workspace',
  'gateway',
  'approvals',
  'audit',
  'secrets',
  'debug',
  'sessions',
  'schedule',
  'validate',
  'logs',
  'builder',
] as const

type Subcommand = (typeof COMMANDS)[number]

const COMMAND_SET = new Set<string>(COMMANDS)

const VALUE_FLAGS = [
  'action',
  'actor',
  'approver',
  'at',
  'cron',
  'events',
  'every',
  'every-ms',
  'filter',
  'format',
  'http-host',
  'http-port',
  'id',
  'input',
  'input-file',
  'last',
  'level',
  'limit',
  'lines',
  'older-than-ms',
  'overlap',
  'reason',
  'run',
  'since',
  'tz',
  'until',
  'value',
  'webhook',
  'workflow',
] as const

const BOOLEAN_FLAGS = [
  'all',
  'cancel-inflight',
  'detach',
  'expired',
  'force',
  'foreground',
  'input-stdin',
  'json',
  'launchd',
  'systemd',
] as const

export interface ParsedArgv {
  command: Subcommand | 'version' | 'help' | 'unknown'
  positional: string[]
  flags: Record<string, string | boolean>
}

export class ArgvParseError extends Error {
  override readonly name = 'ArgvParseError'
}

export function parseArgv(argv: readonly string[]): ParsedArgv {
  if (argv.length === 0) {
    return { command: 'help', positional: [], flags: {} }
  }
  const first = argv[0]
  if (first === undefined) {
    return { command: 'help', positional: [], flags: {} }
  }
  if (first === '--version' || first === '-V') {
    return { command: 'version', positional: [], flags: {} }
  }
  if (first === '--help' || first === '-h') {
    return { command: 'help', positional: [], flags: {} }
  }
  if (!COMMAND_SET.has(first)) {
    return { command: 'unknown', positional: [first], flags: {} }
  }
  return parseSubcommand(first as Subcommand, argv.slice(1))
}

function parseSubcommand(command: Subcommand, rest: readonly string[]): ParsedArgv {
  if (rest.includes('--help') || rest.includes('-h')) {
    return { command: 'help', positional: [command], flags: {} }
  }

  const parser = new Command(command)
    .exitOverride()
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .argument('[args...]')
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    })

  for (const flag of valueFlagsFor(command)) parser.option(`--${flag} <value>`)
  for (const flag of booleanFlagsFor(command)) parser.option(`--${flag}`)

  try {
    parser.parse([...rest], { from: 'user' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ArgvParseError(message.replace(/^error:\s*/i, ''))
  }

  const parsedFlags = dashCaseOptions(parser.opts<Record<string, string | boolean>>())
  const unknown = parseUnknownArgs(parser.args)
  return {
    command,
    positional: unknown.positional,
    flags: { ...parsedFlags, ...unknown.flags },
  }
}

function valueFlagsFor(command: Subcommand): readonly string[] {
  if (command === 'history') return VALUE_FLAGS.filter((flag) => flag !== 'events')
  return VALUE_FLAGS
}

function booleanFlagsFor(command: Subcommand): readonly string[] {
  if (command === 'history') return [...BOOLEAN_FLAGS, 'events']
  return BOOLEAN_FLAGS
}

function dashCaseOptions(opts: Record<string, string | boolean>): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined) continue
    out[key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)] = value
  }
  return out
}

function parseUnknownArgs(args: readonly string[]): {
  positional: string[]
  flags: Record<string, string | boolean>
} {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const raw = arg.slice(2)
    const eq = raw.indexOf('=')
    if (eq >= 0) {
      flags[raw.slice(0, eq)] = raw.slice(eq + 1)
      continue
    }
    const next = args[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[raw] = next
      i++
    } else {
      flags[raw] = true
    }
  }
  return { positional, flags }
}
