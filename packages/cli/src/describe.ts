import type { AgentPermissions, Step, ToolMatcher } from '@skelm/core'
import { EXIT, type ExitCode } from './exit-codes.js'
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

interface DescribedStep {
  readonly id: string
  readonly kind: Step['kind']
  readonly permissions?: string[]
  readonly children?: readonly DescribedStep[]
  readonly branches?: readonly { label: string; step: DescribedStep }[]
}

interface WorkflowDescription {
  readonly id: string
  readonly file: string
  readonly description?: string
  readonly version?: string
  readonly steps: readonly DescribedStep[]
}

export async function describeCommand(
  args: DescribeCommandArgs,
  io: DescribeCommandIO,
): Promise<DescribeCommandResult> {
  const workflow = await resolveWorkflowReference(args.workflow, args.fromDir)
  const described: WorkflowDescription = {
    id: workflow.id,
    file: workflow.file,
    ...(workflow.description !== undefined && { description: workflow.description }),
    ...(workflow.version !== undefined && { version: workflow.version }),
    steps: workflow.pipeline.steps.map(describeStep),
  }

  const format = args.json ? 'json' : (args.format ?? 'human')
  if (format === 'json') {
    io.stdout.write(`${JSON.stringify(described, null, 2)}\n`)
    return { exitCode: EXIT.OK }
  }
  if (format === 'mermaid') {
    io.stdout.write(`${renderMermaid(described)}\n`)
    return { exitCode: EXIT.OK }
  }

  io.stdout.write(`${renderHumanDescription(described)}\n`)
  return { exitCode: EXIT.OK }
}

function describeStep(step: Step): DescribedStep {
  switch (step.kind) {
    case 'parallel':
      return {
        id: step.id,
        kind: step.kind,
        children: step.steps.map(describeStep),
      }
    case 'branch':
      return {
        id: step.id,
        kind: step.kind,
        branches: [
          ...Object.entries(step.cases).map(([label, branchStep]) => ({
            label,
            step: describeStep(branchStep),
          })),
          ...(step.default === undefined
            ? []
            : [{ label: 'default', step: describeStep(step.default) }]),
        ],
      }
    case 'loop':
      return {
        id: step.id,
        kind: step.kind,
        children: [describeStep(step.step)],
      }
    case 'pipelineStep':
      return {
        id: step.id,
        kind: step.kind,
        children: step.pipeline.steps.map(describeStep),
      }
    case 'idempotent':
      return {
        id: step.id,
        kind: step.kind,
        children: [describeStep(step.step)],
      }
    case 'agent':
      return {
        id: step.id,
        kind: step.kind,
        ...(step.permissions !== undefined && {
          permissions: summarizePermissions(step.permissions),
        }),
      }
    default:
      return { id: step.id, kind: step.kind }
  }
}

function summarizePermissions(permissions: AgentPermissions): string[] {
  const parts: string[] = []
  const tools = formatToolMatcher(permissions.allowedTools)
  if (tools !== undefined) {
    parts.push(`tools=${tools}`)
  }
  if (permissions.allowedExecutables?.length) {
    parts.push(`exec=${permissions.allowedExecutables.join(',')}`)
  }
  if (permissions.allowedMcpServers?.length) {
    parts.push(`mcp=${permissions.allowedMcpServers.join(',')}`)
  }
  if (permissions.allowedSkills?.length) {
    parts.push(`skills=${permissions.allowedSkills.join(',')}`)
  }
  return parts
}

function formatToolMatcher(matcher: ToolMatcher | undefined): string | undefined {
  if (matcher === undefined) return undefined
  if (isToolMatcherArray(matcher)) return matcher.join(',')
  const parts = [
    ...(matcher.exact ?? []),
    ...(matcher.prefixes ?? []).map((prefix: string) => `${prefix}*`),
    ...(matcher.star ? ['*'] : []),
  ]
  return parts.length === 0 ? undefined : parts.join(',')
}

function isToolMatcherArray(matcher: ToolMatcher): matcher is readonly string[] {
  return Array.isArray(matcher)
}

function renderHumanDescription(description: WorkflowDescription): string {
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

function renderMermaid(description: WorkflowDescription): string {
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
