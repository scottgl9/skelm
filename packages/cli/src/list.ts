import { EXIT, type ExitCode } from './exit-codes.js'
import { fetchHttp, httpError, requireGateway } from './internal/gateway-client.js'
import type { MainIO } from './internal/io.js'
import { renderTable } from './table.js'

export interface ListCommandArgs {
  json?: boolean
  /** List discovered pipelines (GET /pipelines) instead of the running view. */
  all?: boolean
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
  pipelineId?: string
  file: string
  description?: string
  version?: string
}

interface TriggerView {
  id: string
  workflowId: string
  kind: string
  driver?: string
  fired: number
  lastFiredAt?: string
  inflight: boolean
  lastError?: string
}

interface RunningRun {
  runId: string
  pipelineId: string
  triggerId?: string
  status: string
  startedAt: number
}

interface ActiveView {
  persistentWorkflows: {
    workflowId: string
    triggers: TriggerView[]
    sessions: { count: number; lastUpdatedAt: number | null }
  }[]
  triggers: TriggerView[]
  runsInFlight: RunningRun[]
}

export async function listCommand(
  args: ListCommandArgs,
  io: ListCommandIO,
): Promise<ListCommandResult> {
  const client = await requireGateway(io as MainIO)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }

  const path = args.all === true ? '/pipelines' : '/v1/active'
  const res = await fetchHttp(
    `${client.discovery.url}${path}`,
    { headers: client.headers },
    io as MainIO,
  )
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return (await httpError(res, io as MainIO)) as { exitCode: ExitCode }

  if (args.all === true) {
    return renderPipelines((await res.json()) as RemotePipeline[], args, io)
  }
  return renderActive((await res.json()) as ActiveView, args, io)
}

function renderPipelines(
  workflows: RemotePipeline[],
  args: ListCommandArgs,
  io: ListCommandIO,
): ListCommandResult {
  if (args.json === true) {
    io.stdout.write(`${JSON.stringify(workflows)}\n`)
    return { exitCode: EXIT.OK }
  }
  if (workflows.length === 0) {
    io.stdout.write('No workflows discovered.\n')
    return { exitCode: EXIT.OK }
  }
  const rows = [
    ['ID', 'FILE', 'DESCRIPTION'],
    ...workflows.map((w) => [w.pipelineId ?? w.id, w.file, w.description ?? '']),
  ]
  io.stdout.write(`${renderTable(rows)}\n`)
  return { exitCode: EXIT.OK }
}

function renderActive(
  view: ActiveView,
  args: ListCommandArgs,
  io: ListCommandIO,
): ListCommandResult {
  if (args.json === true) {
    io.stdout.write(`${JSON.stringify(view)}\n`)
    return { exitCode: EXIT.OK }
  }

  if (view.triggers.length === 0 && view.runsInFlight.length === 0) {
    io.stdout.write('No workflows running. (use --all to list discovered pipelines)\n')
    return { exitCode: EXIT.OK }
  }

  const sessionsByWorkflow = new Map<string, number>()
  for (const pw of view.persistentWorkflows)
    sessionsByWorkflow.set(pw.workflowId, pw.sessions.count)

  if (view.triggers.length > 0) {
    const rows = [
      ['WORKFLOW', 'TRIGGER', 'VIA', 'FIRED', 'LAST-FIRED', 'INFLIGHT', 'SESSIONS'],
      ...view.triggers.map((t) => [
        t.workflowId,
        t.id,
        t.driver !== undefined ? `${t.kind}/${t.driver}` : t.kind,
        String(t.fired),
        t.lastFiredAt ?? '—',
        t.inflight ? 'yes' : 'no',
        sessionsByWorkflow.has(t.workflowId) ? String(sessionsByWorkflow.get(t.workflowId)) : '—',
      ]),
    ]
    io.stdout.write(`${renderTable(rows)}\n`)
  }

  if (view.runsInFlight.length > 0) {
    const rows = [
      ['IN-FLIGHT RUN', 'PIPELINE', 'TRIGGER', 'STARTED'],
      ...view.runsInFlight.map((r) => [
        r.runId,
        r.pipelineId,
        r.triggerId ?? '—',
        new Date(r.startedAt).toISOString(),
      ]),
    ]
    io.stdout.write(`\n${renderTable(rows)}\n`)
  }
  return { exitCode: EXIT.OK }
}
