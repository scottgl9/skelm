import { EXIT, type ExitCode } from './exit-codes.js'
import { fetchHttp, httpError, requireGateway } from './internal/gateway-client.js'
import type { MainIO } from './internal/io.js'
import { writeJsonOutput } from './internal/output.js'
import { renderTable } from './table.js'

export interface WorkspaceCommandArgs {
  subcommand: 'list' | 'show' | 'clean'
  workflowId?: string
  name?: string
  json?: boolean
  force?: boolean
  fromDir?: string
}

export interface WorkspaceCommandIO {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  stdin?: NodeJS.ReadableStream
}

export interface WorkspaceCommandResult {
  exitCode: ExitCode
}

interface WorkspaceSummary {
  pipelineId: string
  name: string
  path: string
  locked: boolean
}

export async function workspaceCommand(
  args: WorkspaceCommandArgs,
  io: WorkspaceCommandIO,
): Promise<WorkspaceCommandResult> {
  const client = await requireGateway(io as MainIO)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }

  if (args.subcommand === 'list') {
    const res = await fetchHttp(
      `${client.discovery.url}/workspaces`,
      { headers: client.headers },
      io as MainIO,
    )
    if (res === null) return { exitCode: EXIT.CLI_ERROR }
    if (!res.ok) return (await httpError(res, io as MainIO)) as { exitCode: ExitCode }
    const { workspaces } = (await res.json()) as { workspaces: WorkspaceSummary[] }
    if (args.json) {
      writeJsonOutput(io as MainIO, workspaces)
      return { exitCode: EXIT.OK }
    }
    if (workspaces.length === 0) {
      io.stdout.write('No persistent workspaces found.\n')
      return { exitCode: EXIT.OK }
    }
    const rows = [
      ['WORKFLOW', 'NAME', 'LOCKED', 'PATH'],
      ...workspaces.map((w) => [w.pipelineId, w.name, w.locked ? 'yes' : 'no', w.path]),
    ]
    io.stdout.write(`${renderTable(rows)}\n`)
    return { exitCode: EXIT.OK }
  }

  if (args.workflowId === undefined || args.name === undefined) {
    io.stderr.write(`error: workspace ${args.subcommand} requires <workflow-id> <name>\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
  const path = `/workspaces/${encodeURIComponent(args.workflowId)}/${encodeURIComponent(args.name)}`

  if (args.subcommand === 'show') {
    const res = await fetchHttp(
      `${client.discovery.url}${path}`,
      { headers: client.headers },
      io as MainIO,
    )
    if (res === null) return { exitCode: EXIT.CLI_ERROR }
    if (res.status === 404) {
      io.stderr.write(`error: workspace not found: ${args.workflowId}/${args.name}\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    if (!res.ok) return (await httpError(res, io as MainIO)) as { exitCode: ExitCode }
    const ws = (await res.json()) as WorkspaceSummary
    io.stdout.write(
      args.json
        ? `${JSON.stringify(ws, null, 2)}\n`
        : `workflow: ${ws.pipelineId}\nname: ${ws.name}\npath: ${ws.path}\nlocked: ${ws.locked ? 'yes' : 'no'}\n`,
    )
    return { exitCode: EXIT.OK }
  }

  if (!args.force) {
    io.stderr.write('error: workspace clean requires --force\n')
    return { exitCode: EXIT.CLI_ERROR }
  }
  const res = await fetchHttp(
    `${client.discovery.url}${path}`,
    { method: 'DELETE', headers: client.headers },
    io as MainIO,
  )
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return (await httpError(res, io as MainIO)) as { exitCode: ExitCode }
  io.stdout.write(`cleaned ${args.workflowId}/${args.name}\n`)
  return { exitCode: EXIT.OK }
}
