import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuditEvent, AuditWriter, SecretResolver } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AuditSink,
  ChainAuditWriter,
  ForwardingAuditWriter,
  buildAuditSinks,
} from '../src/index.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skelm-audit-fwd-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

class CapturingSink implements AuditSink {
  readonly events: AuditEvent[] = []
  async forward(event: AuditEvent): Promise<void> {
    this.events.push(event)
  }
}

describe('ForwardingAuditWriter', () => {
  it('forwards each committed record to the injected sink', async () => {
    const path = join(dir, 'audit.jsonl')
    const inner = new ChainAuditWriter(path)
    const sink = new CapturingSink()
    const w = new ForwardingAuditWriter(inner, [sink])
    await w.write({ actor: 'gateway', action: 'tool.dispatch', details: { tool: 'echo' } })
    // Forwarding is fire-and-forget; let the microtask settle.
    await new Promise((r) => setTimeout(r, 10))
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]).toMatchObject({ actor: 'gateway', action: 'tool.dispatch' })
    // Canonical write still happened and verifies.
    expect(await inner.verify()).toBeNull()
  })

  it('a failing sink does NOT break the audit write', async () => {
    const path = join(dir, 'audit.jsonl')
    const inner = new ChainAuditWriter(path)
    const failing: AuditSink = {
      forward: () => Promise.reject(new Error('sink down')),
    }
    const onError = vi.fn()
    const w = new ForwardingAuditWriter(inner, [failing], onError)
    // The write resolves despite the sink rejecting.
    await expect(
      w.write({ actor: 'gateway', action: 'permission.denied' }),
    ).resolves.toBeUndefined()
    await new Promise((r) => setTimeout(r, 10))
    expect(onError).toHaveBeenCalledOnce()
    // Audit record is durable + verifiable.
    const all = await inner.readAll()
    expect(all).toHaveLength(1)
    expect(await inner.verify()).toBeNull()
  })

  it('forwards only what the writer records — no secret value reaches the sink', async () => {
    const path = join(dir, 'audit.jsonl')
    const inner = new ChainAuditWriter(path)
    const sink = new CapturingSink()
    const w = new ForwardingAuditWriter(inner, [sink])
    await w.write({
      actor: 'gateway',
      action: 'secret.resolve',
      details: { secretName: 'OPENAI_API_KEY' },
    })
    await new Promise((r) => setTimeout(r, 10))
    const serialized = JSON.stringify(sink.events)
    expect(serialized).toContain('OPENAI_API_KEY')
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/)
  })
})

describe('buildAuditSinks', () => {
  it('builds a file sink that writes records as JSONL', async () => {
    const out = join(dir, 'forward.jsonl')
    const sinks = await buildAuditSinks([{ kind: 'file', path: out }], stubResolver({}))
    expect(sinks).toHaveLength(1)
    await sinks[0]?.forward({ actor: 'gateway', action: 'x' })
    const text = await readFile(out, 'utf8')
    expect(JSON.parse(text.trim())).toMatchObject({ actor: 'gateway', action: 'x' })
  })

  it('resolves the http sink credential by name and never exposes it', async () => {
    const resolver = stubResolver({ SIEM_TOKEN: 'super-secret-value' })
    const resolveSpy = vi.spyOn(resolver, 'resolve')
    const sinks = await buildAuditSinks(
      [{ kind: 'http', url: 'https://siem.example/ingest', headerSecretName: 'SIEM_TOKEN' }],
      resolver,
    )
    expect(resolveSpy).toHaveBeenCalledWith('SIEM_TOKEN')

    // Capture the outbound request: assert the bearer is present in the header
    // (resolved gateway-side) and that the secret name, not the value, is what
    // config referenced. The value lives only inside the sink closure.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }))
    try {
      await sinks[0]?.forward({ actor: 'gateway', action: 'x' })
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
      const headers = init.headers as Record<string, string>
      // Resolved gateway-side and attached as a bearer; config only ever named
      // the secret, never carried its value.
      expect(headers.authorization).toBe('Bearer super-secret-value')
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

function stubResolver(secrets: Record<string, string>): SecretResolver {
  return {
    resolve: async (name: string) => secrets[name],
  }
}

// Type-only guard: ForwardingAuditWriter is an AuditWriter (the single-writer
// tee contract), not an alternative writer.
const _typecheck: AuditWriter = new ForwardingAuditWriter(new ChainAuditWriter('/dev/null'), [])
void _typecheck
