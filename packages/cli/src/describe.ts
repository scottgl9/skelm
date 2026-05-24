import type { DescribedStep, PipelineDescription } from '@skelm/core'
import { EXIT, type ExitCode } from './exit-codes.js'
import { fetchHttp, httpError, requireGateway } from './internal/gateway-client.js'
import type { MainIO } from './internal/io.js'
import { writeJsonOutput } from './internal/output.js'

export interface DescribeCommandArgs {
  workflow: string
  json?: boolean
  format?: 'human' | 'json' | 'mermaid'
  fromDir?: string
}

export interface DescribeCommandIO {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  stdin?: NodeJS.ReadableStream
}

export interface DescribeCommandResult {
  exitCode: ExitCode
}

interface CliWorkflowDescription extends PipelineDescription {
  readonly file: string
}

interface RemotePipelineDescription {
  id: string
  file: string
  description?: string
  version?: string
  graph: { steps: DescribedStep[] } | null
  input: unknown
  output: unknown
}

export async function describeCommand(
  args: DescribeCommandArgs,
  io: DescribeCommandIO,
): Promise<DescribeCommandResult> {
  const client = await requireGateway(io as MainIO)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }

  // If the argument looks like a file path (has a slash or a known
  // workflow extension), POST to describe-file; otherwise treat it as a
  // workflow id and GET from the registry.
  const looksLikePath = /[\\/]/.test(args.workflow) || /\.(?:m?[tj]s|c[tj]s|tsx?)$/.test(args.workflow)
  let res: Response | null
  if (looksLikePath) {
    const absPath = args.workflow.startsWith('/')
      ? args.workflow
      : `${process.cwd()}/${args.workflow}`
    res = await fetchHttp(
      `${client.discovery.url}/pipelines/describe-file`,
      {
        method: 'POST',
        headers: client.headers,
        body: JSON.stringify({ file: absPath }),
      },
      io as MainIO,
    )
  } else {
    res = await fetchHttp(
      `${client.discovery.url}/pipelines/${encodeURIComponent(args.workflow)}`,
      { headers: client.headers },
      io as MainIO,
    )
  }
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (res.status === 404) {
    io.stderr.write(`error: workflow not found: ${args.workflow}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
  if (!res.ok) return (await httpError(res, io as MainIO)) as { exitCode: ExitCode }
  const remote = (await res.json()) as RemotePipelineDescription

  const described: CliWorkflowDescription = {
    id: remote.id,
    file: remote.file,
    steps: remote.graph?.steps ?? [],
    ...(remote.description !== undefined && { description: remote.description }),
    ...(remote.version !== undefined && { version: remote.version }),
  }

  const format = args.json ? 'json' : (args.format ?? 'human')
  if (format === 'json') {
    writeJsonOutput(io as MainIO, described)
    return { exitCode: EXIT.OK }
  }
  if (format === 'mermaid') {
    io.stdout.write(`${renderMermaid(described)}\n`)
    return { exitCode: EXIT.OK }
  }

  io.stdout.write(`${renderHumanDescription(described)}\n`)
  return { exitCode: EXIT.OK }
}

function renderHumanDescription(description: CliWorkflowDescription): string {
  const lines = [
    `workflow: ${description.id}`,
    `file: ${description.file}`,
    ...(description.description !== undefined ? [`description: ${description.description}`] : []),
    ...(description.version !== undefined ? [`version: ${description.version}`] : []),
    'steps:',
    ...description.steps.flatMap((step) => renderHumanStep(step, 1)),
  ]
  return lines.join('\n')
}

function renderHumanStep(step: DescribedStep, depth: number): string[] {
  const prefix = '  '.repeat(depth - 1)
  const header = `${prefix}- ${step.id} (${step.kind})`
  const permissionLine =
    step.permissions === undefined || step.permissions.length === 0
      ? []
      : [`${prefix}  permissions: ${step.permissions.join('; ')}`]
  const childLines = (step.children ?? []).flatMap((child) => renderHumanStep(child, depth + 1))
  const branchLines = (step.branches ?? []).flatMap((branch) => [
    `${prefix}  [${branch.label}]`,
    ...renderHumanStep(branch.step, depth + 2),
  ])
  return [header, ...permissionLine, ...childLines, ...branchLines]
}

function renderMermaid(description: CliWorkflowDescription): string {
  const lines = ['flowchart TD']
  let counter = 0

  const walk = (step: DescribedStep, parent?: string, label?: string): string => {
    const nodeId = `n${++counter}`
    lines.push(`  ${nodeId}["${step.kind}: ${escapeMermaid(step.id)}"]`)
    if (parent !== undefined) {
      lines.push(
        label === undefined ? `  ${parent} --> ${nodeId}` : `  ${parent} -->|${label}| ${nodeId}`,
      )
    }
    for (const child of step.children ?? []) {
      walk(child, nodeId)
    }
    for (const branch of step.branches ?? []) {
      walk(branch.step, nodeId, branch.label)
    }
    return nodeId
  }

  let previous: string | undefined
  for (const step of description.steps) {
    const current = walk(step)
    if (previous !== undefined) {
      lines.push(`  ${previous} -.-> ${current}`)
    }
    previous = current
  }
  return lines.join('\n')
}

function escapeMermaid(value: string): string {
  return value.replaceAll('"', '\\"')
}
