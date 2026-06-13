import type { MemorySystemConfig } from '../config.js'
import type { MemorySystemDeps, WorkflowOutcome } from '../types.js'
import { logOf, outcome } from './shared.js'

/**
 * Consolidate near-duplicate memories. For each seed query, searches for
 * similar memories; any cluster of hits scoring at or above `duplicateScore`
 * (beyond the seed itself) is folded into one consolidated memory tagged
 * `consolidated`. Read via `search`, write via `save`.
 *
 * Requires `allowSearch` + `allowSave`.
 */
export async function runConsolidation(
  deps: MemorySystemDeps,
  config: MemorySystemConfig,
  input: { queries: readonly string[] },
): Promise<WorkflowOutcome> {
  const log = logOf(deps, 'consolidation')
  let consolidated = 0
  let clustersFound = 0

  for (const query of input.queries) {
    const res = await deps.memory.smartSearch({ query, limit: config.recallLimit })
    const dupes = res.hits.filter((h) => (h.score ?? 0) >= config.duplicateScore)
    if (dupes.length < 2) continue
    clustersFound += 1
    const body = dupes.map((h) => `- ${h.title}: ${h.content.slice(0, 200)}`).join('\n')
    const saved = await deps.memory.save({
      project: config.project,
      title: `Consolidated: ${query}`,
      content: `Merged ${dupes.length} similar memories for "${query}":\n${body}`,
      concepts: ['consolidated', query],
    })
    if (saved.id.length > 0) consolidated += 1
  }

  log('consolidation pass complete', { clustersFound, consolidated })
  return outcome('consolidation', { consolidated, clusters: clustersFound })
}
