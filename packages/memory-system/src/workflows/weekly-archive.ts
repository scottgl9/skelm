import type { MemorySystemConfig } from '../config.js'
import type { MemorySystemDeps, WorkflowOutcome } from '../types.js'
import { clockOf, logOf, outcome, seenKey } from './shared.js'

/**
 * Fold memories older than `archiveAfterMs` into an archive memory. Age is
 * tracked in durable state: a memory's first-seen timestamp is recorded, and
 * once it is older than the threshold its content is re-saved under an
 * `archived` concept. The state record is the age source of truth — the
 * agentmemory recall hit carries no reliable timestamp.
 *
 * Requires `allowRecall` + `allowSave`.
 */
export async function runWeeklyArchive(
  deps: MemorySystemDeps,
  config: MemorySystemConfig,
): Promise<WorkflowOutcome> {
  const log = logOf(deps, 'weekly-archive')
  const now = clockOf(deps)()
  const recall = await deps.memory.recall({ project: config.project, limit: config.recallLimit })

  const toArchive: string[] = []
  for (const hit of recall.hits) {
    const seenAt = await deps.state.get<number>(seenKey(hit.id))
    if (seenAt === undefined) {
      await deps.state.set(seenKey(hit.id), now)
      continue
    }
    if (now - seenAt >= config.archiveAfterMs) toArchive.push(hit.id)
  }

  if (toArchive.length === 0) {
    return outcome('weekly-archive', { archived: 0, scanned: recall.hits.length })
  }

  const byId = new Map(recall.hits.map((h) => [h.id, h]))
  const body = toArchive
    .map((id) => byId.get(id))
    .filter((h): h is NonNullable<typeof h> => h !== undefined)
    .map((h) => `- ${h.title}: ${h.content.slice(0, 200)}`)
    .join('\n')
  const week = new Date(now).toISOString().slice(0, 10)
  const saved = await deps.memory.save({
    project: config.project,
    title: `Weekly archive ${week}`,
    content: `Archived ${toArchive.length} aged memories:\n${body}`,
    concepts: ['archived', `week-${week}`],
  })
  for (const id of toArchive) await deps.state.delete(seenKey(id))
  log('archived aged memories', { count: toArchive.length, id: saved.id })
  return outcome('weekly-archive', {
    archived: toArchive.length,
    scanned: recall.hits.length,
  })
}
