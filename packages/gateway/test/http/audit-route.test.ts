import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChainAuditWriter, type Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

let stateDir: string
let gw: Gateway | undefined
let base: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-audit-route-'))
  // Use ChainAuditWriter explicitly so we can pre-seed entries before
  // boot to assert reads work end-to-end.
  const auditWriter = new ChainAuditWriter(join(stateDir, 'audit.jsonl'))
  await auditWriter.write({
    actor: 'tester',
    action: 'tool.dispatch',
    runId: 'run-1',
    timestamp: new Date('2025-01-01T00:00:00Z').toISOString(),
    details: { tool: 'demo.echo' },
  })
  await auditWriter.write({
    actor: 'tester',
    action: 'permission.denied',
    runId: 'run-2',
    timestamp: new Date('2025-01-02T00:00:00Z').toISOString(),
    details: { permission: 'exec' },
  })
  const booted = await bootGatewayWithRetry((port) => ({
    stateDir,
    enableHttp: true,
    httpPort: port,
    installSignalHandlers: false,
    runStore: new MemoryRunStore(),
  }))
  gw = booted.gw
  base = booted.base
})

afterEach(async () => {
  await gw?.stop()
  gw = undefined
  await rm(stateDir, { recursive: true, force: true })
})

describe('GET /audit', () => {
  it('returns all entries from the chain', async () => {
    const res = await fetch(`${base}/audit`)
    expect(res.status).toBe(200)
    const { entries } = await res.json()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ actor: 'tester', action: 'tool.dispatch', runId: 'run-1' })
  })

  it('filters by runId', async () => {
    const res = await fetch(`${base}/audit?runId=run-2`)
    expect(res.status).toBe(200)
    const { entries } = await res.json()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ runId: 'run-2', action: 'permission.denied' })
  })

  it('applies limit after filtering', async () => {
    const res = await fetch(`${base}/audit?limit=1`)
    expect(res.status).toBe(200)
    const { entries } = await res.json()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ runId: 'run-2' })
  })

  it('rejects an invalid since timestamp with 400', async () => {
    const res = await fetch(`${base}/audit?since=not-a-date`)
    expect(res.status).toBe(400)
  })

  it('rejects an invalid before cursor with 400', async () => {
    const res = await fetch(`${base}/audit?before=0`)
    expect(res.status).toBe(400)
  })

  it('returns a nextBefore cursor for backwards paging', async () => {
    const page1 = await fetch(`${base}/audit?limit=1`)
    expect(page1.status).toBe(200)
    const { entries: e1, nextBefore } = await page1.json()
    expect(e1).toHaveLength(1)
    expect(e1[0]).toMatchObject({ runId: 'run-2' })
    expect(nextBefore).toBe(e1[0].seq)

    const page2 = await fetch(`${base}/audit?limit=1&before=${nextBefore}`)
    expect(page2.status).toBe(200)
    const { entries: e2 } = await page2.json()
    expect(e2).toHaveLength(1)
    expect(e2[0]).toMatchObject({ runId: 'run-1' })
    expect(e2[0].seq).toBeLessThan(nextBefore)
  })
})

describe('GET /audit/verify', () => {
  it('reports ok on a healthy chain', async () => {
    const res = await fetch(`${base}/audit/verify`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })
})

describe('GET /v1/audit/export', () => {
  it('streams JSONL by default with all entries', async () => {
    const res = await fetch(`${base}/v1/audit/export`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    const text = await res.text()
    const lines = text.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)
    expect((JSON.parse(lines[0] ?? '{}') as { action: string }).action).toBe('tool.dispatch')
  })

  it('emits CSV with a stable header and honors filters', async () => {
    const res = await fetch(`${base}/v1/audit/export?format=csv&runId=run-2`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    const lines = (await res.text()).split('\n').filter((l) => l.length > 0)
    expect(lines[0]).toBe('seq,timestamp,actor,action,runId,prevHash,entryHash,details')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('permission.denied')
  })

  it('rejects an unknown format with 400', async () => {
    const res = await fetch(`${base}/v1/audit/export?format=xml`)
    expect(res.status).toBe(400)
  })

  it('never includes a secret value in the export', async () => {
    const both = await Promise.all([
      fetch(`${base}/v1/audit/export`).then((r) => r.text()),
      fetch(`${base}/v1/audit/export?format=csv`).then((r) => r.text()),
    ])
    for (const body of both) {
      expect(body).not.toMatch(/sk-[A-Za-z0-9]{16,}/)
      expect(body).not.toMatch(/Bearer\s+[A-Za-z0-9]/)
    }
  })
})

describe('POST /v1/audit/prune', () => {
  it('refuses without confirm:true (400)', async () => {
    const res = await fetch(`${base}/v1/audit/prune`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ before: 2 }),
    })
    expect(res.status).toBe(400)
  })

  it('prunes the head and the retained tail verifies via the boundary', async () => {
    const res = await fetch(`${base}/v1/audit/prune`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ before: 1, confirm: true }),
    })
    expect(res.status).toBe(200)
    const result = await res.json()
    expect(result.archived).toBe(1)
    expect(result.retained).toBe(1)

    const reader = new ChainAuditWriter(join(stateDir, 'audit.jsonl'))
    expect(await reader.verify({ boundary: result.boundary })).toBeNull()
  })

  it('prunes via the canonical writer so a full prune keeps the chain continuous', async () => {
    // Prune EVERY pre-seeded entry. The route then writes its own audit.pruned
    // record through the SAME canonical writer; with the old throwaway-instance
    // code that record would reset to seq 1 / genesis and orphan the boundary.
    const res = await fetch(`${base}/v1/audit/prune`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ before: 1000, confirm: true }),
    })
    expect(res.status).toBe(200)
    const result = await res.json()
    expect(result.retained).toBe(0)

    const reader = new ChainAuditWriter(join(stateDir, 'audit.jsonl'))
    const all = await reader.readAll()
    // The route's own audit.pruned record continues the chain from the boundary.
    expect(all).toHaveLength(1)
    expect(all[0]?.action).toBe('audit.pruned')
    expect(all[0]?.seq).toBe(result.boundary.prunedThroughSeq + 1)
    expect(all[0]?.prevHash).toBe(result.boundary.boundaryHash)
    expect(await reader.verify({ boundary: result.boundary })).toBeNull()
  })
})
