import type { MemorySystemConfig } from '../config.js'
import type { MemorySystemDeps, WorkflowOutcome } from '../types.js'
import { logOf, outcome } from './shared.js'

/**
 * Promote high-value memories. Recalls recent memories, selects those scoring
 * at or above `promoteScore`, and re-saves each under a `promoted` concept so it
 * surfaces preferentially in future recall. Already-promoted ids are tracked in
 * state so a memory is promoted at most once.
 *
 * Requires `allowRecall` + `allowSave`.
 */
export async function runPromotion(
  deps: MemorySystemDeps,
  config: MemorySystemConfig,
): Promise<WorkflowOutcome> {
  const log = logOf(deps, 'promotion')
  const recall = await deps.memory.recall({ project: config.project, limit: config.recallLimit })

  let promoted = 0
  let skipped = 0
  for (const hit of recall.hits) {
    if ((hit.score ?? 0) < config.promoteScore) continue
    const key = `promotion:done:${hit.id}`
    if ((await deps.state.get<boolean>(key)) === true) {
      skipped += 1
      continue
    }
    const saved = await deps.memory.save({
      project: config.project,
      title: `Promoted: ${hit.title}`,
      content: hit.content,
      concepts: ['promoted', ...(hit.concepts ?? [])],
    })
    if (saved.id.length > 0) {
      await deps.state.set(key, true)
      promoted += 1
    }
  }

  log('promotion pass complete', { promoted, skipped })
  return outcome('promotion', { promoted, skipped, scanned: recall.hits.length })
}
