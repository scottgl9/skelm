import { type DescribedStep, type PipelineDescription, describePipeline } from '@skelm/core'
import { EXIT, type ExitCode } from './exit-codes.js'
import { writeJsonOutput } from './internal/output.js'
import { resolveWorkflowReference } from './workflows.js'

export interface DescribeCommandArgs {
  workflow: string
  json?: boolean
  format?: 'human' | 'json' | 'mermaid'
  fromDir?: string
}

export interface DescribeCommandIO {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

export interface DescribeCommandResult {
  exitCode: ExitCode
}

interface CliWorkflowDescription extends PipelineDescription {
  readonly file: string
}

export async function describeCommand(
  args: DescribeCommandArgs,
  io: DescribeCommandIO,
): Promise<DescribeCommandResult> {
  const workflow = await resolveWorkflowReference(args.workflow, args.fromDir)
  const baseDescription = describePipeline(workflow.pipeline)
  const described: CliWorkflowDescription = {
    ...baseDescription,
    id: workflow.id,
    file: workflow.file,
    ...(workflow.description !== undefined && { description: workflow.description }),
    ...(workflow.version !== undefined && { version: workflow.version }),
  }

  const format = args.json ? 'json' : (args.format ?? 'human')
  if (format === 'json') {
    writeJsonOutput(io, described)
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
