import type { MainIO, MainResult } from './main.js'
import { EXIT } from './exit-codes.js'
import { promises as fs } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { homedir } from 'node:os'

// Local type for better-sqlite3 to avoid dependency on @types/better-sqlite3
interface Database {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown }
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): void
  close(): void
  exec(sql: string): void
  pragma(sql: string): void
}

declare const DatabaseCtor: new (path: string) => Database

export interface AuditQueryArgs {
  runId?: string | undefined
  actor?: string | undefined
  action?: string | undefined
  since?: string | undefined // ISO 8601
  until?: string | undefined // ISO 8601
  limit?: number | undefined
  json?: boolean | undefined
}

export interface SecretsArgs {
  command: 'get' | 'set' | 'list'
  name?: string | undefined
  value?: string | undefined
  json?: boolean | undefined
}

const DEFAULT_DB_PATH = resolve(homedir(), '.skelm', 'runs.sqlite')
const DEFAULT_SECRETS_DIR = resolve(homedir(), '.skelm', 'secrets')

export async function auditCommand(args: AuditQueryArgs, io: MainIO): Promise<MainResult> {
  const dbPath = process.env.SKELM_DB_PATH ?? DEFAULT_DB_PATH

  try {
    await fs.access(dbPath)
  } catch {
    io.stderr.write(`error: run store not found at ${dbPath}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }

  let db: Database
  try {
    // @ts-expect-error - better-sqlite3 runtime import
    const Database = (await import('better-sqlite3')).default
    db = new DatabaseCtor(dbPath)
  } catch (err) {
    io.stderr.write(`error: failed to open database: ${(err as Error).message}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }

  try {
    const entries = queryAudit(db, args)

    if (args.json) {
      io.stdout.write(JSON.stringify(entries, null, 2) + '\n')
    } else {
      if (entries.length === 0) {
        io.stdout.write('No audit entries found\n')
      } else {
        for (const entry of entries) {
          const runIdStr = entry.run_id ? `run:${entry.run_id.slice(0, 8)}... ` : ''
          io.stdout.write(
            `[${new Date(entry.at).toISOString()}] ${runIdStr}${entry.actor} ${entry.action}\n`,
          )
          if (entry.data_json) {
            io.stdout.write(`  ${entry.data_json}\n`)
          }
        }
      }
    }

    return { exitCode: EXIT.OK }
  } catch (err) {
    io.stderr.write(`error: ${(err as Error).message}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  } finally {
    db.close()
  }
}

interface AuditRow {
  run_id: string | null
  actor: string
  action: string
  data_json: string
  at: number
}

function queryAudit(db: Database, args: AuditQueryArgs): AuditRow[] {
  const clauses: string[] = []
  const params: unknown[] = []

  if (args.runId) {
    clauses.push('run_id = ?')
    params.push(args.runId)
  }
  if (args.actor) {
    clauses.push('actor = ?')
    params.push(args.actor)
  }
  if (args.action) {
    clauses.push('action = ?')
    params.push(args.action)
  }
  if (args.since) {
    const sinceTs = Date.parse(args.since)
    if (!isNaN(sinceTs)) {
      clauses.push('at >= ?')
      params.push(sinceTs)
    }
  }
  if (args.until) {
    const untilTs = Date.parse(args.until)
    if (!isNaN(untilTs)) {
      clauses.push('at <= ?')
      params.push(untilTs)
    }
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = args.limit !== undefined ? `LIMIT ${args.limit}` : ''

  const rows = db
    .prepare(
      `SELECT run_id, actor, action, data_json, at FROM audit ${where} ORDER BY at DESC ${limit}`,
    )
    .all(...params) as AuditRow[]

  return rows
}

export async function secretsCommand(args: SecretsArgs, io: MainIO): Promise<MainResult> {
  const secretsDir = process.env.SKELM_SECRETS_DIR ?? DEFAULT_SECRETS_DIR

  switch (args.command) {
    case 'list': {
      try {
        await fs.mkdir(secretsDir, { recursive: true })
        const files = await fs.readdir(secretsDir)
        const secrets = files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))

        if (args.json) {
          io.stdout.write(JSON.stringify(secrets, null, 2) + '\n')
        } else {
          if (secrets.length === 0) {
            io.stdout.write('No secrets found\n')
          } else {
            io.stdout.write('Secrets:\n')
            for (const name of secrets) {
              io.stdout.write(`  ${name}\n`)
            }
          }
        }
        return { exitCode: EXIT.OK }
      } catch (err) {
        io.stderr.write(`error: ${(err as Error).message}\n`)
        return { exitCode: EXIT.CLI_ERROR }
      }
    }

    case 'get': {
      if (!args.name) {
        io.stderr.write('error: secrets get requires a name\n')
        return { exitCode: EXIT.CLI_ERROR }
      }

      const secretPath = resolve(secretsDir, `${args.name}.json`)
      try {
        const content = await fs.readFile(secretPath, 'utf-8')
        const data = JSON.parse(content)

        if (args.json) {
          io.stdout.write(JSON.stringify(data, null, 2) + '\n')
        } else {
          if (typeof data === 'string') {
            io.stdout.write(`${data}\n`)
          } else {
            io.stdout.write(`${JSON.stringify(data)}\n`)
          }
        }
        return { exitCode: EXIT.OK }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          io.stderr.write(`error: secret not found: ${args.name}\n`)
        } else {
          io.stderr.write(`error: ${(err as Error).message}\n`)
        }
        return { exitCode: EXIT.CLI_ERROR }
      }
    }

    case 'set': {
      if (!args.name) {
        io.stderr.write('error: secrets set requires a name\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
      if (args.value === undefined) {
        io.stderr.write('error: secrets set requires a value\n')
        return { exitCode: EXIT.CLI_ERROR }
      }

      const secretPath = resolve(secretsDir, `${args.name}.json`)
      try {
        await fs.mkdir(dirname(secretPath), { recursive: true })
        await fs.writeFile(secretPath, JSON.stringify(args.value, null, 2), 'utf-8')
        return { exitCode: EXIT.OK }
      } catch (err) {
        io.stderr.write(`error: ${(err as Error).message}\n`)
        return { exitCode: EXIT.CLI_ERROR }
      }
    }

    default: {
      const exhaustive: never = args.command
      io.stderr.write(`internal: unknown command ${exhaustive}\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
  }
}
