import type { MemorySystemConfig } from '../config.js'
import type { MemorySystemDeps, WorkflowOutcome } from '../types.js'
import { clockOf, logOf, outcome } from './shared.js'

/**
 * Append a daily rollup note: recalls the day's recent memories and saves one
 * consolidated "daily note" memory tagged with the date. Idempotent per day via
 * a state cursor — a second run on the same date is a no-op.
 *
 * Requires `allowRecall` + `allowSave`.
 */
export async function runDailyNote(
  deps: MemorySystemDeps,
  config: MemorySystemConfig,
): Promise<WorkflowOutcome> {
  const log = logOf(deps, 'daily-note')
  const now = clockOf(deps)()
  const date = new Date(now).toISOString().slice(0, 10)
  const cursorKey = 'daily-note:last-date'

  const last = await deps.state.get<string>(cursorKey)
  if (last === date) {
    log('already appended for date', { date })
    return outcome('daily-note', { appended: 0, recalled: 0 })
  }

  const recall = await deps.memory.recall({ project: config.project, limit: config.recallLimit })
  const hits = recall.hits
  if (hits.length === 0) {
    await deps.state.set(cursorKey, date)
    return outcome('daily-note', { appended: 0, recalled: 0 })
  }

  const body = hits.map((h) => `- ${h.title}: ${h.content.slice(0, 200)}`).join('\n')
  const saved = await deps.memory.save({
    project: config.project,
    title: `Daily note ${date}`,
    content: `Rollup of ${hits.length} memories on ${date}:\n${body}`,
    concepts: ['daily-note', date],
  })
  await deps.state.set(cursorKey, date)
  log('appended daily note', { date, id: saved.id, recalled: hits.length })
  return outcome('daily-note', { appended: saved.id.length > 0 ? 1 : 0, recalled: hits.length })
}
