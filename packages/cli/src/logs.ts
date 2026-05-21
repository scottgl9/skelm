import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EXIT } from './exit-codes.js'
import type { MainIO, MainResult } from './internal/io.js'
import { safeForTty } from './internal/safe-text.js'

export interface LogsArgs {
  /** When omitted, print every line in the file. */
  lines?: number
  /** ISO-8601 lower bound; entries strictly older are dropped. */
  since?: string
  /** Filter by minimum level. Default 'debug' keeps everything. */
  level?: 'debug' | 'info' | 'warn' | 'error'
  /** Substring filter applied to the rendered line. */
  filter?: string
  /** When true, emit the raw JSON-Lines file content (still filtered). */
  json?: boolean
}

const LEVEL_RANK: Record<NonNullable<LogsArgs['level']>, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

interface ParsedEntry {
  raw: string
  timestamp?: string
  level?: string
  message?: string
}

export async function logsCommand(args: LogsArgs, io: MainIO): Promise<MainResult> {
  const path = resolveLogPath()
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      io.stderr.write(`error: gateway log not found at ${path}\n`)
      io.stderr.write('  set SKELM_GATEWAY_LOG to override, or start the gateway first\n')
      return { exitCode: EXIT.CLI_ERROR }
    }
    io.stderr.write(`error: failed to read ${path}: ${(err as Error).message}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }

  const all = raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map(parseLine)

  const minRank = args.level ? LEVEL_RANK[args.level] : 0
  const sinceMs = args.since ? Date.parse(args.since) : Number.NEGATIVE_INFINITY
  if (args.since !== undefined && Number.isNaN(sinceMs)) {
    io.stderr.write('error: --since must be a valid ISO-8601 timestamp\n')
    return { exitCode: EXIT.CLI_ERROR }
  }

  let filtered = all.filter((e) => {
    if (e.level && minRank > 0) {
      const rank = LEVEL_RANK[e.level as keyof typeof LEVEL_RANK] ?? 0
      if (rank < minRank) return false
    }
    if (e.timestamp) {
      const t = Date.parse(e.timestamp)
      if (!Number.isNaN(t) && t < sinceMs) return false
    }
    if (args.filter && !e.raw.includes(args.filter)) return false
    return true
  })

  if (args.lines !== undefined) {
    filtered = filtered.slice(-Math.max(0, args.lines))
  }

  if (filtered.length === 0) {
    io.stderr.write('no matching log entries\n')
    return { exitCode: EXIT.OK }
  }

  for (const entry of filtered) {
    if (args.json) {
      io.stdout.write(`${entry.raw}\n`)
    } else {
      io.stdout.write(`${formatHuman(entry)}\n`)
    }
  }
  return { exitCode: EXIT.OK }
}

function resolveLogPath(): string {
  if (process.env.SKELM_GATEWAY_LOG) return process.env.SKELM_GATEWAY_LOG
  const stateDir = process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm')
  return join(stateDir, 'gateway.log')
}

function parseLine(line: string): ParsedEntry {
  try {
    const obj = JSON.parse(line) as { timestamp?: string; level?: string; message?: string }
    return {
      raw: line,
      ...(obj.timestamp !== undefined && { timestamp: obj.timestamp }),
      ...(obj.level !== undefined && { level: obj.level }),
      ...(obj.message !== undefined && { message: obj.message }),
    }
  } catch {
    return { raw: line }
  }
}

function formatHuman(entry: ParsedEntry): string {
  const ts = entry.timestamp ?? '-'
  const lv = (entry.level ?? 'info').toUpperCase().padEnd(5)
  // Strip ANSI/VT control sequences from message before rendering. Log
  // producers stamp external-API errors and webhook excerpts into
  // entry.message; without stripping, those could move the cursor, clear
  // the screen, or overwrite earlier lines via \r when piped to a TTY.
  const msg = safeForTty(entry.message ?? entry.raw)
  return `${ts}  ${lv}  ${msg}`
}
