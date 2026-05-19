import { EXIT, type ExitCode } from './exit-codes.js'
import { writeJsonOutput } from './internal/output.js'
import { loadSkelmConfig } from './load-config.js'
import { createWorkspaceManager } from './store.js'
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
}

export interface WorkspaceCommandResult {
  exitCode: ExitCode
}

export async function workspaceCommand(
  args: WorkspaceCommandArgs,
  io: WorkspaceCommandIO,
): Promise<WorkspaceCommandResult> {
  const { config } = await loadSkelmConfig({
    ...(args.fromDir !== undefined && { fromDir: args.fromDir }),
  })
  const manager = createWorkspaceManager(config)

  if (args.subcommand === 'list') {
    const workspaces = await manager.listPersistentWorkspaces()
    if (args.json) {
      writeJsonOutput(io, workspaces)
      return { exitCode: EXIT.OK }
    }
    if (workspaces.length === 0) {
      io.stdout.write('No persistent workspaces found.\n')
      return { exitCode: EXIT.OK }
    }
    const rows = [
      ['WORKFLOW', 'NAME', 'LOCKED', 'PATH'],
      ...workspaces.map((workspace) => [
        workspace.pipelineId,
        workspace.name,
        workspace.locked ? 'yes' : 'no',
        workspace.path,
      ]),
    ]
    io.stdout.write(`${renderTable(rows)}\n`)
    return { exitCode: EXIT.OK }
  }

  if (args.workflowId === undefined || args.name === undefined) {
    io.stderr.write(`error: workspace ${args.subcommand} requires <workflow-id> <name>\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }

  if (args.subcommand === 'show') {
    const workspace = await manager.getPersistentWorkspace(args.workflowId, args.name)
    if (workspace === null) {
      io.stderr.write(`error: workspace not found: ${args.workflowId}/${args.name}\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    io.stdout.write(
      args.json
        ? `${JSON.stringify(workspace, null, 2)}\n`
        : `workflow: ${workspace.pipelineId}\nname: ${workspace.name}\npath: ${workspace.path}\nlocked: ${workspace.locked ? 'yes' : 'no'}\n`,
    )
    return { exitCode: EXIT.OK }
  }

  if (!args.force) {
    io.stderr.write('error: workspace clean requires --force\n')
    return { exitCode: EXIT.CLI_ERROR }
  }
  await manager.cleanPersistentWorkspace(args.workflowId, args.name)
  io.stdout.write(`cleaned ${args.workflowId}/${args.name}\n`)
  return { exitCode: EXIT.OK }
}
