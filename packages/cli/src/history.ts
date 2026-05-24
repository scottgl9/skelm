import { EXIT, type ExitCode } from './exit-codes.js'
import { fetchHttp, httpError, requireGateway } from './internal/gateway-client.js'
import type { MainIO } from './internal/io.js'
import { writeJsonOutput } from './internal/output.js'
import { renderTable } from './table.js'

export interface HistoryCommandArgs {
  workflow?: string
  last?: number
  runId?: string
  events?: boolean
  json?: boolean
  fromDir?: string
}

export interface HistoryCommandIO {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  stdin?: NodeJS.ReadableStream
}

export interface HistoryCommandResult {
  exitCode: ExitCode
}

interface RemoteRunSummary {
  runId: string
  pipelineId: string
  status: string
  startedAt: number
  completedAt?: number
}

export async function historyCommand(
  args: HistoryCommandArgs,
  io: HistoryCommandIO,
): Promise<HistoryCommandResult> {
  const client = await requireGateway(io as MainIO)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }

  if (args.runId !== undefined) {
    const runRes = await fetchHttp(
      `${client.discovery.url}/runs/${encodeURIComponent(args.runId)}`,
      { headers: client.headers },
      io as MainIO,
    )
    if (runRes === null) return { exitCode: EXIT.CLI_ERROR }
    if (runRes.status === 404) {
      io.stderr.write(`error: run not found: ${args.runId}\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    if (!runRes.ok) return (await httpError(runRes, io as MainIO)) as { exitCode: ExitCode }
    const run = await runRes.json()
    io.stdout.write(`${JSON.stringify(run, null, 2)}\n`)

    if (args.events) {
      const evRes = await fetchHttp(
        `${client.discovery.url}/runs/${encodeURIComponent(args.runId)}/events?limit=5000`,
        { headers: client.headers },
        io as MainIO,
      )
      if (evRes !== null && evRes.ok) {
        const { events } = (await evRes.json()) as { events: unknown[] }
        for (const e of events) {
          io.stderr.write(`${JSON.stringify(e)}\n`)
        }
      }
    }
    return { exitCode: EXIT.OK }
  }

  const params = new URLSearchParams()
  if (args.workflow !== undefined) params.set('pipelineId', args.workflow)
  params.set('limit', String(args.last ?? 20))
  const res = await fetchHttp(
    `${client.discovery.url}/runs?${params.toString()}`,
    { headers: client.headers },
    io as MainIO,
  )
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return (await httpError(res, io as MainIO)) as { exitCode: ExitCode }
  const runs = (await res.json()) as RemoteRunSummary[]

  if (args.json) {
    writeJsonOutput(io as MainIO, runs)
    return { exitCode: EXIT.OK }
  }

  if (runs.length === 0) {
    io.stdout.write('No runs found.\n')
    return { exitCode: EXIT.OK }
  }

  const rows = [
    ['RUN ID', 'WORKFLOW', 'STATUS', 'STARTED', 'COMPLETED'],
    ...runs.map((r) => [
      r.runId,
      r.pipelineId,
      r.status,
      formatTime(r.startedAt),
      r.completedAt === undefined ? '' : formatTime(r.completedAt),
    ]),
  ]
  io.stdout.write(`${renderTable(rows)}\n`)
  return { exitCode: EXIT.OK }
}

function formatTime(at: number): string {
  return new Date(at).toISOString()
}
