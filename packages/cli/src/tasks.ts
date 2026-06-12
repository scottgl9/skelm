import { EXIT, type ExitCode } from './exit-codes.js'
import { fetchHttp, httpError, requireGateway } from './internal/gateway-client.js'
import type { MainIO } from './internal/io.js'
import { writeJsonOutput } from './internal/output.js'
import { renderTable } from './table.js'

export interface TasksCommandArgs {
  subcommand: 'list' | 'get' | 'cancel' | 'retry'
  id?: string
  status?: string
  parent?: string
  json?: boolean
}

export interface TasksCommandResult {
  exitCode: ExitCode
}

interface TaskRecord {
  taskId: string
  workflowId: string
  status: string
  childRunId?: string
  parentRunId?: string
  createdAt: string
  completedAt?: string
}

export async function tasksCommand(
  args: TasksCommandArgs,
  io: MainIO,
): Promise<TasksCommandResult> {
  const client = await requireGateway(io)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }
  const base = client.discovery.url

  if (args.subcommand === 'list') {
    const params = new URLSearchParams()
    if (args.status !== undefined) params.set('status', args.status)
    if (args.parent !== undefined) params.set('parentRunId', args.parent)
    const qs = params.toString()
    const res = await fetchHttp(
      `${base}/v1/tasks${qs === '' ? '' : `?${qs}`}`,
      { headers: client.headers },
      io,
    )
    if (res === null) return { exitCode: EXIT.CLI_ERROR }
    if (!res.ok) return (await httpError(res, io)) as { exitCode: ExitCode }
    const { tasks } = (await res.json()) as { tasks: TaskRecord[] }
    if (args.json) {
      writeJsonOutput(io, tasks)
      return { exitCode: EXIT.OK }
    }
    if (tasks.length === 0) {
      io.stdout.write('No tasks found.\n')
      return { exitCode: EXIT.OK }
    }
    const rows = [
      ['TASK ID', 'WORKFLOW', 'STATUS', 'CHILD RUN', 'CREATED'],
      ...tasks.map((t) => [t.taskId, t.workflowId, t.status, t.childRunId ?? '', t.createdAt]),
    ]
    io.stdout.write(`${renderTable(rows)}\n`)
    return { exitCode: EXIT.OK }
  }

  if (args.id === undefined) {
    io.stderr.write(`error: skelm tasks ${args.subcommand} requires a task id\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
  const idPath = encodeURIComponent(args.id)

  if (args.subcommand === 'get') {
    const res = await fetchHttp(`${base}/v1/tasks/${idPath}`, { headers: client.headers }, io)
    if (res === null) return { exitCode: EXIT.CLI_ERROR }
    if (res.status === 404) {
      io.stderr.write(`error: task not found: ${args.id}\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    if (!res.ok) return (await httpError(res, io)) as { exitCode: ExitCode }
    const task = (await res.json()) as TaskRecord
    if (args.json) {
      writeJsonOutput(io, task)
      return { exitCode: EXIT.OK }
    }
    io.stdout.write(`${JSON.stringify(task, null, 2)}\n`)
    return { exitCode: EXIT.OK }
  }

  // cancel | retry — POST actions.
  const action = args.subcommand
  const res = await fetchHttp(
    `${base}/v1/tasks/${idPath}/${action}`,
    { method: 'POST', headers: client.headers },
    io,
  )
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return (await httpError(res, io)) as { exitCode: ExitCode }
  const task = (await res.json()) as TaskRecord
  if (args.json) {
    writeJsonOutput(io, task)
    return { exitCode: EXIT.OK }
  }
  io.stdout.write(
    `${action === 'retry' ? 'retried' : 'cancelled'} task ${task.taskId} (status: ${task.status})\n`,
  )
  return { exitCode: EXIT.OK }
}

export interface LineageCommandArgs {
  runId: string
  json?: boolean
}

export async function lineageCommand(
  args: LineageCommandArgs,
  io: MainIO,
): Promise<TasksCommandResult> {
  const client = await requireGateway(io)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }
  const res = await fetchHttp(
    `${client.discovery.url}/v1/lineage/${encodeURIComponent(args.runId)}`,
    { headers: client.headers },
    io,
  )
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (res.status === 404) {
    io.stderr.write(`error: run not found: ${args.runId}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
  if (!res.ok) return (await httpError(res, io)) as { exitCode: ExitCode }
  const lineage = await res.json()
  if (args.json) {
    writeJsonOutput(io, lineage)
    return { exitCode: EXIT.OK }
  }
  io.stdout.write(`${JSON.stringify(lineage, null, 2)}\n`)
  return { exitCode: EXIT.OK }
}
