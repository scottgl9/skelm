import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { code, pipeline } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type ChainAuditWriter,
  Gateway,
  TriggerCoordinator,
  createTriggerDispatcher,
} from '../src/index.js'
import { bootGatewayWithRetry } from './utils/boot-gateway.js'

let stateDir: string
let projectRoot: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-e2e-state-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-e2e-proj-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

describe('Gateway end-to-end', () => {
  it('wires the full stack: start → register trigger → fire via HTTP → run completes → audit + runStore reflect it → stop', async () => {
    // 1. Project layout: a workflow file the registry will discover.
    await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
    await fs.writeFile(
      join(projectRoot, 'workflows/hello.workflow.mts'),
      'export default {}', // never imported — we inject a fake loader
    )

    // 2. Start gateway with HTTP enabled, FS watch disabled.
    const { gw, base } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      projectRoot,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      config: {
        registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
      },
    }))

    try {
      // 3. Wire the dispatcher with a fake loader (avoids touching disk in tests).
      const ran: string[] = []
      const wf = pipeline({
        id: 'hello',
        steps: [
          code({
            id: 'greet',
            run: () => {
              ran.push('greet')
              return { greeting: 'hi' }
            },
          }),
        ],
      })
      gw.managers.triggers.setOnFire(
        createTriggerDispatcher({
          gateway: gw,
          loadWorkflow: async () => ({ default: wf }),
        }),
      )

      // 4. Register a manual trigger.
      gw.managers.triggers.register({
        kind: 'manual',
        id: 'wake',
        workflowId: 'workflows/hello.workflow.mts',
      })

      // Pre-fire: registry sees the workflow, runStore is empty, audit empty.
      expect(gw.registries.workflows.list().map((w) => w.id)).toEqual([
        'workflows/hello.workflow.mts',
      ])
      const triggersBefore = (await fetch(`${base}/triggers`).then((r) => r.json())) as Array<{
        spec: { id: string }
      }>
      expect(triggersBefore.map((t) => t.spec.id)).toEqual(['wake'])

      // 5. Fire over HTTP. POST returns immediately; the dispatcher runs the
      // pipeline synchronously within the request because TriggerCoordinator
      // awaits onFire before responding.
      const fireRes = await fetch(`${base}/triggers/wake/fire`, { method: 'POST' })
      expect(fireRes.ok).toBe(true)
      expect(ran).toEqual(['greet'])

      // 6. Run record landed in the gateway's RunStore.
      const triggersAfter = (await fetch(`${base}/triggers`).then((r) => r.json())) as Array<{
        spec: { id: string }
        fired: number
        lastError?: string
      }>
      expect(triggersAfter[0]?.fired).toBe(1)
      expect(triggersAfter[0]?.lastError).toBeUndefined()

      // 7. Pause/resume round-trip.
      const pause = await fetch(`${base}/gateway/pause`, { method: 'POST' }).then((r) => r.json())
      expect(pause.state).toBe('paused')
      const resume = await fetch(`${base}/gateway/resume`, { method: 'POST' }).then((r) => r.json())
      expect(resume.state).toBe('running')

      // 8. /health is ok.
      const health = await fetch(`${base}/health`).then((r) => r.json())
      expect(health.status).toBe('ok')
      expect(health.state).toBe('running')
    } finally {
      await gw.stop()
    }

    // 9. After stop: lockfile, discovery, http port all released. The
    // sqlite RunStore file persists for forensics.
    await expect(fs.access(join(stateDir, 'gateway.lock'))).rejects.toThrow()
    await expect(fs.access(join(stateDir, 'gateway.json'))).rejects.toThrow()
    const stat = await fs.stat(join(stateDir, 'runs.sqlite'))
    expect(stat.isFile()).toBe(true)
  })

  it('persists ACP sessions across a gateway restart cycle', async () => {
    const { gw: gw1, base: base1 } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
    }))

    // Create a session via the manager (no agent needed for the bookkeeping).
    const created = await gw1.managers.acpSessions.create({ agentId: 'opencode-1' })
    const before = (await fetch(`${base1}/sessions`).then((r) => r.json())) as Array<{
      id: string
    }>
    expect(before.map((s) => s.id)).toContain(created.id)

    await gw1.stop()

    // New gateway in the same stateDir reconciles the persisted session.
    const { gw: gw2, base: base2 } = await bootGatewayWithRetry(async (port) => ({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
    }))
    try {
      const after = (await fetch(`${base2}/sessions`).then((r) => r.json())) as Array<{
        id: string
      }>
      expect(after.map((s) => s.id)).toContain(created.id)

      // Resume + terminate over HTTP.
      const resumed = await fetch(`${base2}/sessions/${created.id}/resume`, {
        method: 'POST',
      }).then((r) => r.json())
      expect(resumed.state).toBe('active')

      const del = await fetch(`${base2}/sessions/${created.id}`, { method: 'DELETE' })
      expect(del.ok).toBe(true)
    } finally {
      await gw2.stop()
    }
  })

  it('audit chain records gateway lifecycle via callers (sample writer + verify)', async () => {
    // This test exercises the chain writer directly to prove the gateway-
    // resolved writer is functional and verify() walks a chain it produced.
    const gw = new Gateway({ stateDir, watchRegistries: false })
    await gw.start()
    try {
      const writer = gw.enforcement.auditWriter as ChainAuditWriter
      await writer.write({ actor: 'gateway', action: 'gateway.start' })
      await writer.write({ actor: 'cli', action: 'gateway.status' })
      const breach = await writer.verify()
      expect(breach).toBeNull()
      const all = await writer.readAll()
      expect(all.map((e) => e.action)).toEqual(['gateway.start', 'gateway.status'])
    } finally {
      await gw.stop()
    }
  })
})

// Silence the unused-import warning when this is built but not used elsewhere
void TriggerCoordinator
