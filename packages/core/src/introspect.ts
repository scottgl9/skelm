import type { Pipeline, Step, StepKind } from './types.js'

/**
 * A step as seen by inspection: every step kind reports its id and kind, and
 * structural kinds (parallel, branch, loop, pipelineStep, idempotent, forEach)
 * carry their nested children so callers can walk the full graph.
 *
 * The `agent` kind also carries a tiny permission summary so consumers can
 * render permission-aware diagrams without re-implementing the formatter.
 */
export interface DescribedStep {
  readonly id: string
  readonly kind: StepKind
  readonly permissions?: readonly string[]
  readonly children?: readonly DescribedStep[]
  readonly branches?: readonly { readonly label: string; readonly step: DescribedStep }[]
}

export interface PipelineDescription {
  readonly id: string
  readonly description?: string
  readonly version?: string
  readonly steps: readonly DescribedStep[]
}

/**
 * Walk a Pipeline and produce a serializable DescribedStep tree. Used by
 * `skelm describe` for human / json / mermaid output, and by the gateway's
 * GET /pipelines/:id for the same data over HTTP.
 */
export function describePipeline(pipeline: Pipeline): PipelineDescription {
  const out: PipelineDescription = {
    id: pipeline.id,
    steps: pipeline.steps.map(describeStep),
  }
  if (pipeline.description !== undefined)
    (out as { description?: string }).description = pipeline.description
  if (pipeline.version !== undefined) (out as { version?: string }).version = pipeline.version
  return out
}

export function describeStep(step: Step): DescribedStep {
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
            step: describeStep(branchStep as Step),
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
    case 'forEach':
      // forEach.step is a factory (item, index) => Step, so the body cannot
      // be described statically. Report kind + id only.
      return { id: step.id, kind: step.kind }
    case 'agent': {
      const out: DescribedStep = { id: step.id, kind: step.kind }
      if (step.permissions !== undefined) {
        const summary = summarizePermissions(step.permissions)
        if (summary.length > 0) (out as { permissions?: readonly string[] }).permissions = summary
      }
      return out
    }
    default:
      return { id: step.id, kind: step.kind }
  }
}

function summarizePermissions(permissions: import('./permissions.js').AgentPermissions): string[] {
  const parts: string[] = []
  const tools = formatToolMatcher(permissions.allowedTools)
  if (tools !== undefined) parts.push(`tools=${tools}`)
  if (permissions.allowedExecutables?.length) {
    parts.push(`exec=${permissions.allowedExecutables.join(',')}`)
  }
  if (permissions.executableProfiles?.length) {
    parts.push(`execProfiles=${permissions.executableProfiles.join(',')}`)
  }
  if (permissions.allowedMcpServers?.length) {
    parts.push(`mcp=${permissions.allowedMcpServers.join(',')}`)
  }
  if (permissions.allowedSkills?.length) {
    parts.push(`skills=${permissions.allowedSkills.join(',')}`)
  }
  return parts
}

function formatToolMatcher(
  matcher: import('./permissions.js').ToolMatcher | undefined,
): string | undefined {
  if (matcher === undefined) return undefined
  if (Array.isArray(matcher)) return matcher.join(',')
  const m = matcher as { exact?: readonly string[]; prefixes?: readonly string[]; star?: boolean }
  const parts = [
    ...(m.exact ?? []),
    ...((m.prefixes ?? []) as readonly string[]).map((prefix) => `${prefix}*`),
    ...(m.star ? ['*'] : []),
  ]
  return parts.length === 0 ? undefined : parts.join(',')
}
