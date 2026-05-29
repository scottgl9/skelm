/**
 * Plan §1.1: agentmemory operations must flow through the same single
 * audit writer as every other privileged action. Without this wiring,
 * observe / search / session events bypassed ChainAuditWriter — invisible
 * to `skelm audit query` and to compliance review.
 *
 * The handle's `audit` callback is exercised end-to-end against a real
 * gateway here; the conversion shape (AuditEvent.action mirrors the
 * AgentmemoryAuditEvent.type) is asserted explicitly.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type AuditEvent, type AuditWriter, DEFAULT_CONFIG, type SkelmConfig } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Gateway } from '../src/index.js'

class RecordingAuditWriter implements AuditWriter {
  readonly entries: AuditEvent[] = []
  async write(entry: AuditEvent): Promise<void> {
    this.entries.push(entry)
  }
}

let stateDir: string

function baseConfig(): SkelmConfig {
  const server = DEFAULT_CONFIG.server ?? {}
  return {
    ...DEFAULT_CONFIG,
    server: { ...server, port: 0, proxy: { ...(server.proxy ?? {}), port: 0 } },
    agentmemory: { enabled: true, url: 'http://memory.invalid:3111', timeoutMs: 50 },
  }
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, id: 'srv-1', hits: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  )
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-gw-am-audit-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await rm(stateDir, { recursive: true, force: true })
})

describe('gateway agentmemory audit wiring', () => {
  it('writes one audit entry per agentmemory op into the gateway AuditWriter', async () => {
    stubFetch()
    const auditWriter = new RecordingAuditWriter()
    const gw = new Gateway({ stateDir, enableHttp: false, auditWriter, config: baseConfig() })
    await gw.start()
    try {
      const factory = gw.agentmemoryRunOptions().agentmemoryHandleFactory
      expect(factory).toBeTypeOf('function')
      const handle = factory?.({
        runId: 'run-42',
        stepId: 'step-1',
        canUseAgentmemory: () => ({ allow: true }),
      })
      expect(handle).toBeDefined()
      if (handle === undefined) return

      await handle.startSession({ sessionId: 'sess-1', project: 'p', cwd: 'p' })
      await handle.observe({ sessionId: 'sess-1', hookType: 'post_tool_use', data: {} })
      await handle.smartSearch({ query: 'q1' })
      await handle.endSession({ sessionId: 'sess-1' })

      const actions = auditWriter.entries.map((e) => e.action)
      expect(actions).toEqual([
        'agentmemory.session.start',
        'agentmemory.observe',
        'agentmemory.search',
        'agentmemory.session.end',
      ])
      for (const entry of auditWriter.entries) {
        expect(entry.actor).toBe('agentmemory')
        expect(entry.runId).toBe('run-42')
        expect(typeof entry.timestamp).toBe('string')
        // Details carries the per-op payload (sessionId, hookType, query, hits)
        // but never the raw event `type` (already in `action`) or `at` (already
        // in `timestamp`).
        expect((entry.details as Record<string, unknown>).type).toBeUndefined()
        expect((entry.details as Record<string, unknown>).at).toBeUndefined()
      }
    } finally {
      await gw.stop()
    }
  })

  it('does not throw out of the handle when the audit writer rejects', async () => {
    stubFetch()
    const failingWriter: AuditWriter = {
      async write() {
        throw new Error('audit write failed')
      },
    }
    const gw = new Gateway({
      stateDir,
      enableHttp: false,
      auditWriter: failingWriter,
      config: baseConfig(),
    })
    await gw.start()
    try {
      const handle = gw.agentmemoryRunOptions().agentmemoryHandleFactory?.({
        runId: 'r',
        stepId: 's',
        canUseAgentmemory: () => ({ allow: true }),
      })
      // The audit failure is swallowed (`.catch` on the fire-and-forget write);
      // observe() resolves normally so the agent loop keeps going.
      await expect(
        handle?.observe({ sessionId: 's', hookType: 'post_tool_use', data: {} }),
      ).resolves.toBeUndefined()
    } finally {
      await gw.stop()
    }
  })
})
