import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { FileSecretResolver } from '@skelm/gateway'
import { EXIT } from './exit-codes.js'
import { fetchHttp, httpError, requireGateway } from './internal/gateway-client.js'
import type { MainIO, MainResult } from './internal/io.js'
import { writeJsonOutput } from './internal/output.js'

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

interface AuditEntry {
  seq: number
  timestamp: string
  actor: string
  action: string
  runId?: string
  details?: unknown
}

export async function auditCommand(args: AuditQueryArgs, io: MainIO): Promise<MainResult> {
  const client = await requireGateway(io)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }

  if (args.verify) {
    const res = await fetchHttp(
      `${client.discovery.url}/audit/verify`,
      { headers: client.headers },
      io,
    )
    if (res === null) return { exitCode: EXIT.CLI_ERROR }
    if (!res.ok) return (await httpError(res, io)) as MainResult
    const body = (await res.json()) as { ok: boolean; breach?: { seq: number; reason: string } }
    if (body.ok) {
      io.stdout.write('audit chain ok\n')
      return { exitCode: EXIT.OK }
    }
    io.stderr.write(`audit chain broken at seq ${body.breach?.seq}: ${body.breach?.reason}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }

  const qs = new URLSearchParams()
  if (args.runId) qs.set('runId', args.runId)
  if (args.actor) qs.set('actor', args.actor)
  if (args.action) qs.set('action', args.action)
  if (args.since) qs.set('since', args.since)
  if (args.until) qs.set('until', args.until)
  if (args.limit !== undefined) qs.set('limit', String(args.limit))

  const res = await fetchHttp(
    `${client.discovery.url}/audit?${qs.toString()}`,
    { headers: client.headers },
    io,
  )
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return (await httpError(res, io)) as MainResult
  const { entries } = (await res.json()) as { entries: AuditEntry[] }

  if (args.json) {
    writeJsonOutput(io, entries)
    return { exitCode: EXIT.OK }
  }
  if (entries.length === 0) {
    io.stdout.write('no audit entries\n')
    return { exitCode: EXIT.OK }
  }
  for (const e of entries) {
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
        writeJsonOutput(io, names)
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
