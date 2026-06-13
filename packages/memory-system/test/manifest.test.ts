import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePackageManifest } from '@skelm/core'
import { describe, expect, it } from 'vitest'
import consolidation from '../src/pipelines/consolidation.pipeline.js'
import dailyNote from '../src/pipelines/daily-note.pipeline.js'
import integrityAudit from '../src/pipelines/integrity-audit.pipeline.js'
import promotion from '../src/pipelines/promotion.pipeline.js'
import searchHealth from '../src/pipelines/search-health.pipeline.js'
import sessionSummary from '../src/pipelines/session-summary.pipeline.js'
import stalePrune from '../src/pipelines/stale-prune.pipeline.js'
import weeklyArchive from '../src/pipelines/weekly-archive.pipeline.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const manifestPath = join(__dirname, '..', 'skelm.package.json')
const manifest = parsePackageManifest(readFileSync(manifestPath, 'utf8'), manifestPath)

const pipelines = [
  dailyNote,
  sessionSummary,
  weeklyArchive,
  consolidation,
  promotion,
  stalePrune,
  searchHealth,
  integrityAudit,
]

describe('pipeline entrypoints', () => {
  it('each is a valid pipeline that arms no triggers itself', () => {
    for (const p of pipelines) {
      expect(p.id).toMatch(/^memory-/)
      expect(p.steps.length).toBeGreaterThan(0)
      // Triggers are offered through the manifest only, never armed in code.
      expect(p.triggers).toBeUndefined()
    }
  })

  it('threads the effective summaryMaxTokens into the session-summary infer step', async () => {
    const summarize = sessionSummary.steps.find((step) => step.id === 'summarize')
    expect(summarize?.kind).toBe('infer')
    expect(typeof summarize?.maxTokens).toBe('function')
    if (typeof summarize?.maxTokens !== 'function') {
      throw new Error('expected summarize.maxTokens to be a function')
    }
    await expect(
      Promise.resolve(
        summarize.maxTokens({
          get: () => ({ summaryMaxTokens: 321 }),
        } as never),
      ),
    ).resolves.toBe(321)
  })
})

describe('manifest', () => {
  it('parses and declares all eight workflows plus the default alias', () => {
    expect(manifest.name).toBe('@skelm/memory-system')
    const ids = manifest.skelm.workflows.map((w) => w.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'default',
        'daily-note',
        'session-summary',
        'weekly-archive',
        'consolidation',
        'promotion',
        'stale-prune',
        'search-health',
        'integrity-audit',
      ]),
    )
  })

  it('declares per-workflow agentmemory permission ceilings', () => {
    const byId = new Map(manifest.skelm.workflows.map((w) => [w.id, w]))
    const stale = byId.get('stale-prune')
    const perms = stale?.permissions as { agentmemory?: Record<string, boolean> } | undefined
    expect(perms?.agentmemory?.allowRecall).toBe(true)
    // Read-only: no save grant in the ceiling.
    expect(perms?.agentmemory?.allowSave).toBeUndefined()
  })

  it('offers cron triggers that are disabled by default (offered, never armed)', () => {
    const triggers = manifest.skelm.triggers ?? []
    expect(triggers.length).toBeGreaterThan(0)
    for (const t of triggers) {
      expect(t.kind).toBe('cron')
      // The substrate never carries an `enabled` flag — offered triggers are
      // disabled until an operator enables them. The manifest must not assert
      // any enabled state.
      expect((t as Record<string, unknown>).enabled).toBeUndefined()
      expect(t.description ?? '').toMatch(/disabled until enabled by an operator/i)
    }
  })

  it('declares the agentmemory secret by name only', () => {
    const secrets = manifest.skelm.secrets ?? []
    expect(secrets.map((s) => s.name)).toContain('AGENTMEMORY_TOKEN')
  })
})
