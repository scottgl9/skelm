import { EXIT, type ExitCode } from './exit-codes.js'
import { fetchHttp, httpError, requireGateway } from './internal/gateway-client.js'
import type { MainIO } from './internal/io.js'
import { renderTable } from './table.js'

export interface ListCommandArgs {
  json?: boolean
  /** Retained for source compatibility — ignored since discovery happens gateway-side. */
  fromDir?: string
}

export interface ListCommandIO {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  stdin?: NodeJS.ReadableStream
}

export interface ListCommandResult {
  exitCode: ExitCode
}

interface RemotePipeline {
  id: string
  file: string
  description?: string
  version?: string
}

export async function listCommand(
  args: ListCommandArgs,
  io: ListCommandIO,
): Promise<ListCommandResult> {
  const client = await requireGateway(io as MainIO)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }

  const res = await fetchHttp(
    `${client.discovery.url}/pipelines`,
    { headers: client.headers },
    io as MainIO,
  )
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return (await httpError(res, io as MainIO)) as { exitCode: ExitCode }
  const workflows = (await res.json()) as RemotePipeline[]

  if (args.json) {
    io.stdout.write(`${JSON.stringify(workflows)}\n`)
    return { exitCode: EXIT.OK }
  }

  if (workflows.length === 0) {
    io.stdout.write('No workflows discovered.\n')
    return { exitCode: EXIT.OK }
  }

  const rows = [
    ['ID', 'FILE', 'DESCRIPTION'],
    ...workflows.map((w) => [w.id, w.file, w.description ?? '']),
  ]
  io.stdout.write(`${renderTable(rows)}\n`)
  return { exitCode: EXIT.OK }
}
