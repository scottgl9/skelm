import { EXIT, type ExitCode } from './exit-codes.js'
import { renderTable } from './table.js'
import { discoverWorkflows } from './workflows.js'

export interface ListCommandArgs {
  json?: boolean
  fromDir?: string
}

export interface ListCommandIO {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

export interface ListCommandResult {
  exitCode: ExitCode
}

export async function listCommand(
  args: ListCommandArgs,
  io: ListCommandIO,
): Promise<ListCommandResult> {
  const workflows = await discoverWorkflows(args.fromDir)
  if (args.json) {
    io.stdout.write(
      `${JSON.stringify(
        workflows.map((workflow) => ({
          id: workflow.id,
          file: workflow.file,
          ...(workflow.description !== undefined && { description: workflow.description }),
          ...(workflow.version !== undefined && { version: workflow.version }),
        })),
      )}\n`,
    )
    return { exitCode: EXIT.OK }
  }

  if (workflows.length === 0) {
    io.stdout.write('No workflows discovered.\n')
    return { exitCode: EXIT.OK }
  }

  const rows = [
    ['ID', 'FILE', 'DESCRIPTION'],
    ...workflows.map((workflow) => [workflow.id, workflow.file, workflow.description ?? '']),
  ]
  io.stdout.write(`${renderTable(rows)}\n`)
  return { exitCode: EXIT.OK }
}
