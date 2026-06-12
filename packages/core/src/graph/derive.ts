import type { AgentPermissions, ToolMatcher } from '../permissions.js'
import { PERSISTENT_TURN_STEP_ID } from '../persistent-workflow.js'
import type { PersistentWorkflow } from '../persistent-workflow.js'
import type {
  AgentStep,
  BranchStep,
  CodeStep,
  ForEachStep,
  IdempotentStep,
  InferStep,
  InvokeStep,
  LoopStep,
  ParallelStep,
  Pipeline,
  PipelineStep,
  Step,
  WaitStep,
} from '../types.js'
import type { AgentPermissionsSummary, GraphEdge, GraphNode, WorkflowGraph } from './types.js'

/**
 * Derive a read-only {@link WorkflowGraph} from an authored workflow. Pure,
 * deterministic, and side-effect-free: the same workflow always yields an
 * identical graph, and no author function or secret value is ever serialized
 * into the result. Control-flow steps nest their sub-steps in `children`;
 * inline predicates / run functions are represented as `codeOwned` regions
 * rather than serialized.
 */
export function deriveWorkflowGraph(workflow: Pipeline | PersistentWorkflow): WorkflowGraph {
  if (isPersistentWorkflow(workflow)) return derivePersistentWorkflowGraph(workflow)
  return derivePipelineGraph(workflow)
}

function isPersistentWorkflow(value: Pipeline | PersistentWorkflow): value is PersistentWorkflow {
  return (value as { kind?: unknown }).kind === 'persistent-workflow'
}

function derivePipelineGraph(pipeline: Pipeline): WorkflowGraph {
  const nodes = pipeline.steps.map(deriveNode)
  const edges = sequentialControlEdges(nodes.map((n) => n.id))
  return {
    id: pipeline.id,
    ...(pipeline.version !== undefined && { version: pipeline.version }),
    kind: 'pipeline',
    nodes,
    edges,
    ...(pipeline.finalize !== undefined && { meta: { hasFinalize: true } }),
  }
}

function derivePersistentWorkflowGraph(workflow: PersistentWorkflow): WorkflowGraph {
  const preamble = (workflow.steps ?? []).map(deriveNode)
  const turn = derivePersistentTurnNode(workflow)
  const nodes = [...preamble, turn]
  const edges = sequentialControlEdges(nodes.map((n) => n.id))
  return {
    id: workflow.id,
    kind: 'persistent-workflow',
    nodes,
    edges,
  }
}

function derivePersistentTurnNode(workflow: PersistentWorkflow): GraphNode {
  const agent = workflow.agent
  const data: Record<string, unknown> = {}
  if (agent.backend !== undefined) data.backend = agent.backend
  if (agent.model !== undefined) data.model = agent.model
  if (agent.maxTurns !== undefined) data.maxTurns = agent.maxTurns
  const node: GraphNode = {
    id: PERSISTENT_TURN_STEP_ID,
    kind: 'agent',
    summary: 'persistent terminal turn',
    ...(agent.permissions !== undefined && {
      permissions: summarizePermissions(agent.permissions),
    }),
    ...(Object.keys(data).length > 0 && { data }),
  }
  return node
}

function sequentialControlEdges(ids: readonly string[]): GraphEdge[] {
  const edges: GraphEdge[] = []
  for (let i = 1; i < ids.length; i++) {
    edges.push({ from: ids[i - 1] as string, to: ids[i] as string, kind: 'control' })
  }
  return edges
}

function deriveNode(step: Step): GraphNode {
  switch (step.kind) {
    case 'code':
      return deriveCode(step)
    case 'infer':
      return deriveInfer(step)
    case 'agent':
      return deriveAgent(step)
    case 'parallel':
      return deriveParallel(step)
    case 'branch':
      return deriveBranch(step)
    case 'forEach':
      return deriveForEach(step)
    case 'loop':
      return deriveLoop(step)
    case 'wait':
      return deriveWait(step)
    case 'pipelineStep':
      return derivePipelineStep(step)
    case 'invoke':
      return deriveInvoke(step)
    case 'idempotent':
      return deriveIdempotent(step)
  }
}

function deriveCode(step: CodeStep): GraphNode {
  const data: Record<string, unknown> = {}
  if (step.module !== undefined) data.module = step.module
  if (step.export !== undefined) data.export = step.export
  // An inline `run` function is author code we cannot round-trip to source;
  // a `module` reference is a stable path the editor can preserve.
  const codeOwned = step.run !== undefined
  return {
    id: step.id,
    kind: 'code',
    ...(codeOwned && { codeOwned: true }),
    ...(step.permissions !== undefined && { permissions: summarizePermissions(step.permissions) }),
    ...(Object.keys(data).length > 0 && { data }),
  }
}

function deriveInfer(step: InferStep): GraphNode {
  const data: Record<string, unknown> = {}
  if (step.backend !== undefined) data.backend = step.backend
  if (step.model !== undefined) data.model = step.model
  return {
    id: step.id,
    kind: 'infer',
    ...(Object.keys(data).length > 0 && { data }),
  }
}

function deriveAgent(step: AgentStep): GraphNode {
  const data: Record<string, unknown> = {}
  if (step.backend !== undefined) data.backend = step.backend
  if (step.maxTurns !== undefined) data.maxTurns = step.maxTurns
  return {
    id: step.id,
    kind: 'agent',
    ...(step.permissions !== undefined && { permissions: summarizePermissions(step.permissions) }),
    ...(Object.keys(data).length > 0 && { data }),
  }
}

function deriveParallel(step: ParallelStep): GraphNode {
  const data: Record<string, unknown> = {}
  if (step.waitFor !== undefined) data.waitFor = step.waitFor
  if (step.onError !== undefined) data.onError = step.onError
  return {
    id: step.id,
    kind: 'parallel',
    children: step.steps.map(deriveNode),
    ...(Object.keys(data).length > 0 && { data }),
  }
}

function deriveBranch(step: BranchStep): GraphNode {
  const children: GraphNode[] = []
  for (const [caseName, caseStep] of Object.entries(step.cases)) {
    children.push(withCaseData(deriveNode(caseStep as Step), caseName))
  }
  if (step.default !== undefined) {
    children.push(withCaseData(deriveNode(step.default), 'default'))
  }
  return {
    id: step.id,
    kind: 'branch',
    // The discriminator `on` is an author predicate we cannot serialize.
    codeOwned: true,
    children,
  }
}

function withCaseData(node: GraphNode, caseName: string): GraphNode {
  return { ...node, data: { ...(node.data ?? {}), case: caseName } }
}

function deriveForEach(step: ForEachStep): GraphNode {
  // `items` and `step` are author functions: the per-item body is built lazily
  // and cannot be described statically, so the whole node is code-owned.
  return {
    id: step.id,
    kind: 'forEach',
    codeOwned: true,
    ...(step.concurrency !== undefined && { data: { concurrency: step.concurrency } }),
  }
}

function deriveLoop(step: LoopStep): GraphNode {
  return {
    id: step.id,
    kind: 'loop',
    // The `while` predicate is author code we cannot serialize.
    codeOwned: true,
    children: [deriveNode(step.step)],
    data: { maxIterations: step.maxIterations },
  }
}

function deriveWait(step: WaitStep): GraphNode {
  const data: Record<string, unknown> = {}
  if (typeof step.message === 'string') data.message = step.message
  else if (typeof step.message === 'function') data.messageIsDynamic = true
  if (step.timeoutMs !== undefined) data.timeoutMs = step.timeoutMs
  return {
    id: step.id,
    kind: 'wait',
    ...(Object.keys(data).length > 0 && { data }),
  }
}

function derivePipelineStep(step: PipelineStep): GraphNode {
  const data: Record<string, unknown> = { pipelineId: step.pipeline.id }
  if (typeof step.input === 'function') data.inputIsDynamic = true
  return {
    id: step.id,
    kind: 'pipelineStep',
    children: step.pipeline.steps.map(deriveNode),
    data,
  }
}

function deriveInvoke(step: InvokeStep): GraphNode {
  const data: Record<string, unknown> = { pipelineId: step.pipelineId }
  if (typeof step.input === 'function') data.inputIsDynamic = true
  return {
    id: step.id,
    kind: 'invoke',
    data,
  }
}

function deriveIdempotent(step: IdempotentStep): GraphNode {
  const data: Record<string, unknown> = {}
  if (typeof step.key === 'string') data.key = step.key
  else data.keyIsDynamic = true
  if (step.ttlMs !== undefined) data.ttlMs = step.ttlMs
  return {
    id: step.id,
    kind: 'idempotent',
    children: [deriveNode(step.step)],
    data,
  }
}

/**
 * Build a redacted permission summary: the present dimensions plus profile /
 * executable-profile names only. No secret value, host, path, or executable
 * binary name reaches the summary — those would leak operational surface a
 * read-only graph has no business carrying.
 */
function summarizePermissions(permissions: AgentPermissions): AgentPermissionsSummary {
  const dimensions: string[] = []
  const note = (present: boolean, dim: string): void => {
    if (present) dimensions.push(dim)
  }
  note(hasMatcher(permissions.allowedTools) || hasMatcher(permissions.deniedTools), 'tool')
  note(
    (permissions.allowedExecutables?.length ?? 0) > 0 ||
      (permissions.executableProfiles?.length ?? 0) > 0,
    'executable',
  )
  note((permissions.allowedMcpServers?.length ?? 0) > 0, 'mcp')
  note((permissions.allowedSkills?.length ?? 0) > 0, 'skill')
  note((permissions.allowedSecrets?.length ?? 0) > 0, 'secret')
  note(permissions.networkEgress !== undefined, 'network')
  note((permissions.fsRead?.length ?? 0) > 0, 'fs.read')
  note((permissions.fsWrite?.length ?? 0) > 0, 'fs.write')
  note(permissions.agentmemory !== undefined, 'agentmemory')
  note(hasMatcher(permissions.delegation), 'delegation')
  return {
    dimensions,
    ...(permissions.profile !== undefined && { profile: permissions.profile }),
    ...(permissions.executableProfiles !== undefined &&
      permissions.executableProfiles.length > 0 && {
        executableProfiles: [...permissions.executableProfiles],
      }),
  }
}

function hasMatcher(matcher: ToolMatcher | undefined): boolean {
  if (matcher === undefined) return false
  if (Array.isArray(matcher)) return matcher.length > 0
  const m = matcher as { exact?: readonly string[]; prefixes?: readonly string[]; star?: boolean }
  return (m.exact?.length ?? 0) > 0 || (m.prefixes?.length ?? 0) > 0 || m.star === true
}
