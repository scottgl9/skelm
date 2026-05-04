import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChainAuditWriter, FileSecretResolver } from '@skelm/gateway'
import { EXIT } from './exit-codes.js'
import type { MainIO, MainResult } from './main.js'

export interface AuditQueryArgs {
  runId?: string | undefined
  actor?: string | undefined
  action?: string | undefined
  since?: string | undefined
  until?: string | undefined
  limit?: number | undefined
  json?: boolean | undefined
  /** Override the audit chain path (defaults to $SKELM_STATE_DIR or ~/.skelm). */
  path?: string | undefined
  /** Run integrity verification only and report the first break (or success). */
  verify?: boolean | undefined
}

export interface SecretsArgs {
  command: 'get' | 'set' | 'list'
  name?: string | undefined
  value?: string | undefined
  json?: boolean | undefined
  path?: string | undefined
}

function defaultStateDir(): string {
  return process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm')
}

export async function auditCommand(args: AuditQueryArgs, io: MainIO): Promise<MainResult> {
  const auditPath = args.path ?? join(defaultStateDir(), 'audit.jsonl')
  const writer = new ChainAuditWriter(auditPath)

  if (args.verify) {
    const breach = await writer.verify()
    if (breach === null) {
      io.stdout.write(`audit chain ok (${auditPath})\n`)
      return { exitCode: EXIT.OK }
    }
    io.stderr.write(`audit chain broken at seq ${breach.seq}: ${breach.reason}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }

  const all = await writer.readAll()
  const sinceTs = args.since ? Date.parse(args.since) : null
  const untilTs = args.until ? Date.parse(args.until) : null
  const filtered = all.filter((e) => {
    if (args.runId && e.runId !== args.runId) return false
    if (args.actor && e.actor !== args.actor) return false
    if (args.action && e.action !== args.action) return false
    const ts = Date.parse(e.timestamp)
    if (sinceTs !== null && ts < sinceTs) return false
    if (untilTs !== null && ts > untilTs) return false
    return true
  })
  const limited = args.limit !== undefined ? filtered.slice(-args.limit) : filtered

  if (args.json) {
    io.stdout.write(`${JSON.stringify(limited, null, 2)}\n`)
    return { exitCode: EXIT.OK }
  }

  if (limited.length === 0) {
    io.stdout.write('no audit entries\n')
    return { exitCode: EXIT.OK }
  }
  for (const e of limited) {
    const runStr = e.runId ? ` run:${e.runId.slice(0, 8)}` : ''
    io.stdout.write(`#${e.seq} ${e.timestamp} ${e.actor} ${e.action}${runStr}\n`)
    if (e.details !== undefined) {
      io.stdout.write(`  ${JSON.stringify(e.details)}\n`)
    }
  }
  return { exitCode: EXIT.OK }
}

export async function secretsCommand(args: SecretsArgs, io: MainIO): Promise<MainResult> {
  const path = args.path ?? join(defaultStateDir(), 'secrets.json')
  const resolver = new FileSecretResolver(path)

  switch (args.command) {
    case 'list': {
      const names = await resolver.list()
      if (args.json) {
        io.stdout.write(`${JSON.stringify(names, null, 2)}\n`)
      } else if (names.length === 0) {
        io.stdout.write('no secrets configured\n')
      } else {
        for (const n of names) io.stdout.write(`${n}\n`)
      }
      return { exitCode: EXIT.OK }
    }
    case 'get': {
      if (args.name === undefined) {
        io.stderr.write('error: secrets get requires a name\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
      const value = await resolver.resolve(args.name)
      if (value === undefined) {
        io.stderr.write(`error: secret not found: ${args.name}\n`)
        return { exitCode: EXIT.CLI_ERROR }
      }
      io.stdout.write(`${value}\n`)
      return { exitCode: EXIT.OK }
    }
    case 'set': {
      if (args.name === undefined) {
        io.stderr.write('error: secrets set requires a name\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
      if (args.value === undefined) {
        io.stderr.write('error: secrets set requires --value <value>\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
      await resolver.set(args.name, args.value)
      io.stdout.write(`secret stored: ${args.name} (${resolve(path)})\n`)
      return { exitCode: EXIT.OK }
    }
  }
}
