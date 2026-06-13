import type { MemorySystemConfig } from '../config.js'
import type { MemorySystemDeps, WorkflowOutcome } from '../types.js'
import { logOf, outcome } from './shared.js'

/**
 * Probe search-index health by running a set of canary queries and recording
 * how many returned hits and the mean top score. A query that returns zero hits
 * is counted as a miss. The health snapshot is written to state under
 * `search-health:last`. Read-only — `allowSearch` only, no save.
 */
export async function runSearchHealth(
  deps: MemorySystemDeps,
  config: MemorySystemConfig,
  input: { queries: readonly string[] },
): Promise<WorkflowOutcome> {
  const log = logOf(deps, 'search-health')
  let misses = 0
  let totalHits = 0
  let scoreSum = 0
  let scored = 0

  for (const query of input.queries) {
    const res = await deps.memory.smartSearch({ query, limit: config.recallLimit })
    if (res.hits.length === 0) {
      misses += 1
      continue
    }
    totalHits += res.hits.length
    const top = res.hits[0]?.score
    if (typeof top === 'number') {
      scoreSum += top
      scored += 1
    }
  }

  const meanTopScore = scored > 0 ? scoreSum / scored : 0
  await deps.state.set('search-health:last', {
    queries: input.queries.length,
    misses,
    totalHits,
    meanTopScore,
  })
  log('search health snapshot', { queries: input.queries.length, misses, totalHits })
  return outcome('search-health', {
    queries: input.queries.length,
    misses,
    hits: totalHits,
  })
}
