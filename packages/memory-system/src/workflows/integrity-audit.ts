import type { MemorySystemConfig } from '../config.js'
import type { MemorySystemDeps, WorkflowOutcome } from '../types.js'
import { logOf, outcome } from './shared.js'

/**
 * Audit memory integrity: recall memories and, for each declared concept query,
 * graph-query the knowledge graph, then report memories that carry empty
 * content or ids and graph edges whose endpoints are not present as nodes
 * (dangling references). The audit report is written to state under
 * `integrity-audit:last`. Read-only — `allowRecall` + `allowGraph`, no save.
 */
export async function runIntegrityAudit(
  deps: MemorySystemDeps,
  config: MemorySystemConfig,
  input: { conceptQueries: readonly string[] },
): Promise<WorkflowOutcome> {
  const log = logOf(deps, 'integrity-audit')
  const recall = await deps.memory.recall({ project: config.project, limit: config.recallLimit })
  const emptyMemories = recall.hits.filter(
    (h) => h.id.length === 0 || h.content.trim().length === 0,
  ).length

  let danglingEdges = 0
  let edgesChecked = 0
  for (const query of input.conceptQueries) {
    const graph = await deps.memory.graphQuery({
      project: config.project,
      query,
      limit: config.recallLimit,
    })
    const nodeIds = new Set(graph.nodes.map((n) => n.id))
    for (const edge of graph.edges) {
      edgesChecked += 1
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) danglingEdges += 1
    }
  }

  await deps.state.set('integrity-audit:last', {
    memoriesChecked: recall.hits.length,
    emptyMemories,
    edgesChecked,
    danglingEdges,
  })
  log('integrity audit complete', { emptyMemories, danglingEdges, edgesChecked })
  return outcome('integrity-audit', {
    emptyMemories,
    danglingEdges,
    memoriesChecked: recall.hits.length,
  })
}
