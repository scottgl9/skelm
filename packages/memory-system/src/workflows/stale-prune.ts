import type { MemorySystemConfig } from '../config.js'
import type { MemorySystemDeps, WorkflowOutcome } from '../types.js'
import { clockOf, logOf, outcome, seenKey } from './shared.js'

/**
 * Identify stale memories — those first seen longer ago than `staleAfterMs` and
 * not seen in the latest recall — and record the stale id list in durable state
 * under `stale-prune:candidates`. This workflow is intentionally read-only on
 * agentmemory: it has no `allowSave`, so it can report staleness but cannot
 * delete or rewrite memories. Actual deletion is an operator-gated follow-up.
 *
 * Requires `allowRecall` only — default-deny proves it cannot save.
 */
export async function runStalePrune(
  deps: MemorySystemDeps,
  config: MemorySystemConfig,
): Promise<WorkflowOutcome> {
  const log = logOf(deps, 'stale-prune')
  const now = clockOf(deps)()
  const recall = await deps.memory.recall({ project: config.project, limit: config.recallLimit })
  const liveIds = new Set(recall.hits.map((h) => h.id))

  for (const hit of recall.hits) {
    if ((await deps.state.get<number>(seenKey(hit.id))) === undefined) {
      await deps.state.set(seenKey(hit.id), now)
    }
  }

  const stale: string[] = []
  for await (const entry of deps.state.list('seen:')) {
    const id = entry.key.slice('seen:'.length)
    const seenAt = typeof entry.value === 'number' ? entry.value : undefined
    if (seenAt === undefined) continue
    const aged = now - seenAt >= config.staleAfterMs
    if (aged && !liveIds.has(id)) stale.push(id)
  }

  await deps.state.set('stale-prune:candidates', stale)
  log('stale scan complete', { stale: stale.length, live: liveIds.size })
  return outcome('stale-prune', { stale: stale.length, live: liveIds.size })
}
