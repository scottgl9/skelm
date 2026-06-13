import { describe, expect, it } from 'vitest'
import { resolveMemorySystemConfig } from '../src/config.js'
import { fixedClock, makeFakeMemory, makeFakeState } from '../src/testing.js'
import type { MemoryRecord, MemorySystemDeps, Summarizer } from '../src/types.js'
import { runConsolidation } from '../src/workflows/consolidation.js'
import { runDailyNote } from '../src/workflows/daily-note.js'
import { runIntegrityAudit } from '../src/workflows/integrity-audit.js'
import { runPromotion } from '../src/workflows/promotion.js'
import { runSearchHealth } from '../src/workflows/search-health.js'
import { runSessionSummary } from '../src/workflows/session-summary.js'
import { runStalePrune } from '../src/workflows/stale-prune.js'
import { runWeeklyArchive } from '../src/workflows/weekly-archive.js'

const config = resolveMemorySystemConfig({ project: 'p' })
const mem = (rec: readonly MemoryRecord[]): MemoryRecord[] => [...rec]

function deps(
  partial: Partial<MemorySystemDeps> & Pick<MemorySystemDeps, 'memory'>,
): MemorySystemDeps {
  return { state: makeFakeState(), project: 'p', ...partial }
}

describe('daily-note', () => {
  it('recalls then saves a single rollup tagged with the date', async () => {
    const memory = makeFakeMemory('daily-note', {
      recall: mem([{ id: 'a', title: 'T', content: 'C' }]),
    })
    const d = deps({ memory, now: fixedClock(Date.parse('2026-06-12T00:00:00Z')) })
    const out = await runDailyNote(d, config)
    expect(out.ok).toBe(true)
    expect(out.stats.recalled).toBe(1)
    expect(memory.calls.map((c) => c.op)).toEqual(['recall', 'save'])
    expect(memory.saved[0]?.concepts).toContain('2026-06-12')
  })

  it('is idempotent per day via the state cursor', async () => {
    const memory = makeFakeMemory('daily-note', {
      recall: mem([{ id: 'a', title: 'T', content: 'C' }]),
    })
    const state = makeFakeState()
    const now = fixedClock(Date.parse('2026-06-12T09:00:00Z'))
    await runDailyNote(deps({ memory, state, now }), config)
    const memory2 = makeFakeMemory('daily-note', {
      recall: mem([{ id: 'a', title: 'T', content: 'C' }]),
    })
    const out = await runDailyNote(deps({ memory: memory2, state, now }), config)
    expect(out.stats.appended).toBe(0)
    expect(memory2.saved.length).toBe(0)
  })
})

describe('session-summary', () => {
  it('summarizes recalled memories via the stubbed summarizer and saves', async () => {
    const memory = makeFakeMemory('session-summary', {
      recall: mem([{ id: 'a', title: 'A', content: 'fact one' }]),
    })
    const summarizer: Summarizer = { summarize: async () => 'condensed summary' }
    const out = await runSessionSummary(deps({ memory, summarizer }), config, { sessionId: 's1' })
    expect(out.ok).toBe(true)
    expect(memory.saved[0]?.content).toBe('condensed summary')
    expect(memory.calls.map((c) => c.op)).toEqual(['recall', 'save'])
  })

  it('throws when no summarizer is provided', async () => {
    const memory = makeFakeMemory('session-summary', {
      recall: mem([{ id: 'a', title: 'A', content: 'c' }]),
    })
    await expect(runSessionSummary(deps({ memory }), config, { sessionId: 's' })).rejects.toThrow(
      /summarizer/,
    )
  })
})

describe('weekly-archive', () => {
  it('archives only memories older than the threshold', async () => {
    const t0 = 1_000_000
    const archiveConfig = resolveMemorySystemConfig({ project: 'p', archiveAfterMs: 1000 })
    const recall = mem([{ id: 'old', title: 'O', content: 'c' }])
    const memory1 = makeFakeMemory('weekly-archive', { recall })
    const state = makeFakeState()
    // First pass records first-seen; nothing aged yet.
    const first = await runWeeklyArchive(
      deps({ memory: memory1, state, now: fixedClock(t0) }),
      archiveConfig,
    )
    expect(first.stats.archived).toBe(0)
    expect(memory1.saved.length).toBe(0)
    // Second pass, well past the threshold: archives.
    const memory2 = makeFakeMemory('weekly-archive', { recall })
    const second = await runWeeklyArchive(
      deps({ memory: memory2, state, now: fixedClock(t0 + 5000) }),
      archiveConfig,
    )
    expect(second.stats.archived).toBe(1)
    expect(memory2.saved[0]?.concepts).toContain('archived')
  })
})

describe('consolidation', () => {
  it('folds clusters of high-score duplicates into one memory', async () => {
    const memory = makeFakeMemory('consolidation', {
      search: {
        jwt: mem([
          { id: '1', title: 'A', content: 'x', score: 0.95 },
          { id: '2', title: 'B', content: 'y', score: 0.92 },
        ]),
      },
    })
    const out = await runConsolidation(deps({ memory }), config, { queries: ['jwt'] })
    expect(out.stats.consolidated).toBe(1)
    expect(memory.saved[0]?.concepts).toContain('consolidated')
  })

  it('ignores singletons and below-threshold scores', async () => {
    const memory = makeFakeMemory('consolidation', {
      search: { q: mem([{ id: '1', title: 'A', content: 'x', score: 0.5 }]) },
    })
    const out = await runConsolidation(deps({ memory }), config, { queries: ['q'] })
    expect(out.stats.consolidated).toBe(0)
    expect(memory.saved.length).toBe(0)
  })
})

describe('promotion', () => {
  it('promotes high-score memories once', async () => {
    const recall = mem([
      { id: 'hi', title: 'H', content: 'c', score: 0.9 },
      { id: 'lo', title: 'L', content: 'c', score: 0.1 },
    ])
    const state = makeFakeState()
    const memory1 = makeFakeMemory('promotion', { recall })
    const out1 = await runPromotion(deps({ memory: memory1, state }), config)
    expect(out1.stats.promoted).toBe(1)
    const memory2 = makeFakeMemory('promotion', { recall })
    const out2 = await runPromotion(deps({ memory: memory2, state }), config)
    expect(out2.stats.promoted).toBe(0)
    expect(out2.stats.skipped).toBe(1)
  })
})

describe('stale-prune', () => {
  it('reports aged memories that are no longer live and never saves', async () => {
    const staleConfig = resolveMemorySystemConfig({ project: 'p', staleAfterMs: 1000 })
    const state = makeFakeState({ 'seen:gone': 0 })
    const memory = makeFakeMemory('stale-prune', {
      recall: mem([{ id: 'live', title: 'L', content: 'c' }]),
    })
    const out = await runStalePrune(deps({ memory, state, now: fixedClock(5000) }), staleConfig)
    expect(out.ok).toBe(true)
    expect(out.stats.stale).toBe(1)
    expect(await state.get('stale-prune:candidates')).toEqual(['gone'])
    expect(memory.calls.some((c) => c.op === 'save')).toBe(false)
  })
})

describe('search-health', () => {
  it('counts misses and records a snapshot', async () => {
    const memory = makeFakeMemory('search-health', {
      search: { hit: mem([{ id: '1', title: 'A', content: 'c', score: 0.8 }]) },
    })
    const state = makeFakeState()
    const out = await runSearchHealth(deps({ memory, state }), config, { queries: ['hit', 'miss'] })
    expect(out.stats.misses).toBe(1)
    expect(out.stats.hits).toBe(1)
    expect(await state.get('search-health:last')).toMatchObject({ misses: 1 })
  })
})

describe('integrity-audit', () => {
  it('flags empty memories and dangling graph edges', async () => {
    const memory = makeFakeMemory('integrity-audit', {
      recall: mem([
        { id: 'ok', title: 'T', content: 'c' },
        { id: 'empty', title: 'E', content: '   ' },
      ]),
      graph: { nodes: [{ id: 'n1', label: 'n1' }], edges: [{ from: 'n1', to: 'missing' }] },
    })
    const out = await runIntegrityAudit(deps({ memory }), config, { conceptQueries: ['c'] })
    expect(out.stats.emptyMemories).toBe(1)
    expect(out.stats.danglingEdges).toBe(1)
  })
})
