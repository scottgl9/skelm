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
