import { createWriteStream } from 'node:fs'
import { Writable } from 'node:stream'
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
  /** Seq cursor for backwards paging: return only entries with seq < before. */
  before?: number | undefined
  json?: boolean | undefined
  /** Override the audit chain path (defaults to $SKELM_STATE_DIR or ~/.skelm). */
  path?: string | undefined
  /** Run integrity verification only and report the first break (or success). */
  verify?: boolean | undefined
}

export interface AuditExportArgs {
  format?: 'jsonl' | 'csv' | undefined
  runId?: string | undefined
  actor?: string | undefined
  action?: string | undefined
  since?: string | undefined
  until?: string | undefined
  before?: number | undefined
  /** Destination file; when omitted, stream to stdout. */
  out?: string | undefined
}

export interface AuditPruneArgs {
  /** Archive entries with seq <= before; keep the rest. */
  before?: number | undefined
  /** Required acknowledgement that pruning is destructive. */
  confirm?: boolean | undefined
  json?: boolean | undefined
}

export interface SecretsArgs {
  command: 'get' | 'set' | 'list'
  name?: string | undefined
  value?: string | undefined
  json?: boolean | undefined
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
  if (args.before !== undefined) qs.set('before', String(args.before))

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

export async function auditExportCommand(args: AuditExportArgs, io: MainIO): Promise<MainResult> {
  const client = await requireGateway(io)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }

  const qs = new URLSearchParams()
  qs.set('format', args.format ?? 'jsonl')
  if (args.runId) qs.set('runId', args.runId)
  if (args.actor) qs.set('actor', args.actor)
  if (args.action) qs.set('action', args.action)
  if (args.since) qs.set('since', args.since)
  if (args.until) qs.set('until', args.until)
  if (args.before !== undefined) qs.set('before', String(args.before))

  const res = await fetchHttp(
    `${client.discovery.url}/v1/audit/export?${qs.toString()}`,
    { headers: client.headers },
    io,
  )
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return (await httpError(res, io)) as MainResult
  if (res.body === null) {
    io.stderr.write('error: gateway returned an empty export stream\n')
    return { exitCode: EXIT.CLI_ERROR }
  }

  // Stream the response straight to the sink without buffering the whole
  // export — the gateway already streamed it line-by-line off the chain.
  const sink: Writable = args.out !== undefined ? createWriteStream(args.out) : toWritable(io)
  try {
    const reader = res.body.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value !== undefined) await writeChunk(sink, Buffer.from(value))
    }
  } catch (err) {
    io.stderr.write(`error: audit export failed: ${err instanceof Error ? err.message : err}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  } finally {
    if (args.out !== undefined) await endWritable(sink)
  }
  return { exitCode: EXIT.OK }
}

export async function auditPruneCommand(args: AuditPruneArgs, io: MainIO): Promise<MainResult> {
  if (args.before === undefined) {
    io.stderr.write('error: audit prune requires --before <seq>\n')
    return { exitCode: EXIT.CLI_ERROR }
  }
  if (args.confirm !== true) {
    io.stderr.write(
      'error: audit prune is destructive and refuses without --confirm. ' +
        'The archived head and retained tail verify separately, not as one chain.\n',
    )
    return { exitCode: EXIT.CLI_ERROR }
  }
  const client = await requireGateway(io)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }

  const res = await fetchHttp(
    `${client.discovery.url}/v1/audit/prune`,
    {
      method: 'POST',
      headers: client.headers,
      body: JSON.stringify({ before: args.before, confirm: true }),
    },
    io,
  )
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return (await httpError(res, io)) as MainResult
  const result = (await res.json()) as {
    archived: number
    retained: number
    boundary: { archivePath: string }
  }
  if (args.json) {
    writeJsonOutput(io, result)
    return { exitCode: EXIT.OK }
  }
  io.stdout.write(
    `pruned ${result.archived} entr${result.archived === 1 ? 'y' : 'ies'} ` +
      `(kept ${result.retained}); archived to ${result.boundary.archivePath}\n`,
  )
  return { exitCode: EXIT.OK }
}

function toWritable(io: MainIO): Writable {
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      io.stdout.write(chunk.toString('utf8'))
      cb()
    },
  })
}

function writeChunk(sink: Writable, chunk: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sink.write(chunk, (err) => (err ? reject(err) : resolve()))
  })
}

function endWritable(sink: Writable): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sink.on('error', reject)
    sink.end(() => resolve())
  })
}

export async function secretsCommand(args: SecretsArgs, io: MainIO): Promise<MainResult> {
  const client = await requireGateway(io)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }

  switch (args.command) {
    case 'list': {
      const res = await fetchHttp(
        `${client.discovery.url}/secrets`,
        { headers: client.headers },
        io,
      )
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return (await httpError(res, io)) as MainResult
      const { names } = (await res.json()) as { names: string[] }
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
      // Existence check only — the gateway intentionally never returns
      // plaintext over HTTP. Workflows resolve secret values gateway-side
      // via the in-process SecretResolver. Use `secrets set` to overwrite.
      //
      // Exit semantics (documented in help.ts + docs/CHANGELOG.md):
      //   - set     → stdout "<name>: set"      / exit 0
      //   - not set → stdout "<name>: not set"  / exit 1 (EXIT.CLI_ERROR)
      // The non-zero exit on "not set" makes `secrets get FOO || …`
      // chainable in shell scripts. Use --json to get a structured
      // {set: boolean} payload if you'd rather branch on stdout.
      const res = await fetchHttp(
        `${client.discovery.url}/secrets/${encodeURIComponent(args.name)}`,
        { headers: client.headers },
        io,
      )
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (res.status === 404) {
        if (args.json) {
          writeJsonOutput(io, { name: args.name, set: false })
        } else {
          io.stdout.write(`${args.name}: not set\n`)
        }
        return { exitCode: EXIT.CLI_ERROR }
      }
      if (!res.ok) return (await httpError(res, io)) as MainResult
      if (args.json) {
        writeJsonOutput(io, { name: args.name, set: true })
      } else {
        io.stdout.write(`${args.name}: set\n`)
      }
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
      const res = await fetchHttp(
        `${client.discovery.url}/secrets/${encodeURIComponent(args.name)}`,
        {
          method: 'PUT',
          headers: client.headers,
          body: JSON.stringify({ value: args.value }),
        },
        io,
      )
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return (await httpError(res, io)) as MainResult
      io.stdout.write(`secret stored: ${args.name}\n`)
      return { exitCode: EXIT.OK }
    }
  }
}
