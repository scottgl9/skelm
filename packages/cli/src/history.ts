import { EXIT, type ExitCode } from './exit-codes.js'
import { writeJsonOutput } from './internal/output.js'
import { loadSkelmConfig } from './load-config.js'
import { closeRunStore, createRunStore } from './store.js'
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
}

export interface HistoryCommandResult {
  exitCode: ExitCode
}

export async function historyCommand(
  args: HistoryCommandArgs,
  io: HistoryCommandIO,
): Promise<HistoryCommandResult> {
  const { config } = await loadSkelmConfig({
    ...(args.fromDir !== undefined && { fromDir: args.fromDir }),
  })
  const store = createRunStore(config)
  try {
    if (args.runId !== undefined) {
      const run = await store.getRun(args.runId)
      if (run === null) {
        io.stderr.write(`error: run not found: ${args.runId}\n`)
        return { exitCode: EXIT.CLI_ERROR }
      }
      io.stdout.write(`${JSON.stringify(run, null, args.json ? 2 : 2)}\n`)
      if (args.events) {
        for await (const event of store.listEvents(run.runId)) {
          io.stderr.write(`${JSON.stringify(event)}\n`)
        }
      }
      return { exitCode: EXIT.OK }
    }

    const runs = await collect(
      store.listRuns({
        ...(args.workflow !== undefined && { pipelineId: args.workflow }),
        limit: args.last ?? 20,
      }),
    )

    if (args.json) {
      writeJsonOutput(io, runs)
      return { exitCode: EXIT.OK }
    }

    if (runs.length === 0) {
      io.stdout.write('No runs found.\n')
      return { exitCode: EXIT.OK }
    }

    const rows = [
      ['RUN ID', 'WORKFLOW', 'STATUS', 'STARTED', 'COMPLETED'],
      ...runs.map((run) => [
        run.runId,
        run.pipelineId,
        run.status,
        formatTime(run.startedAt),
        run.completedAt === undefined ? '' : formatTime(run.completedAt),
      ]),
    ]
    io.stdout.write(`${renderTable(rows)}\n`)
    return { exitCode: EXIT.OK }
  } finally {
    closeRunStore(store)
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) {
    out.push(item)
  }
  return out
}

function formatTime(at: number): string {
  return new Date(at).toISOString()
}
