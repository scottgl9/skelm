// P4 — public surface shape lock.
//
// Writes a minimal memory-backed mock for each M4 seam interface and
// confirms the mock satisfies the contract without modifying core code.
// Purpose: if a refactor of RunStore or SecretResolver breaks the shape,
// it surfaces here (typecheck + runtime) before the M4 implementation
// has to migrate.
//
// "append-only semantics" for RunStore means: putRun/appendEvent are
// the only mutations; updateRun patches in-place (allowed — matches
// what Postgres will do via UPDATE); deleteState/casState round out the
// interface.

import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../src/events.js'
import type { RunStore, SecretResolver } from '../src/index.js'
import type { AuditEntry, RunFilter, RunSummary } from '../src/run-store.js'
import type { Run, RunId, StateEntry, StateReadOptions, StateSetOptions } from '../src/types.js'

// ---------------------------------------------------------------------------
// Minimal MemorySecretResolver — append-only (set once, never mutated)
// ---------------------------------------------------------------------------

class MemorySecretResolver implements SecretResolver {
  readonly #store = new Map<string, string>()

  /** Add a secret. Throws if the name already exists (append-only contract). */
  add(name: string, value: string): void {
    if (this.#store.has(name)) {
      throw new Error(`MemorySecretResolver: secret '${name}' already set (append-only)`)
    }
    this.#store.set(name, value)
  }

  async resolve(name: string): Promise<string | undefined> {
    return this.#store.get(name)
  }
}

// ---------------------------------------------------------------------------
// Minimal MemoryRunStore — simple in-process store for shape verification
// ---------------------------------------------------------------------------

class MinimalRunStore implements RunStore {
  readonly #runs = new Map<RunId, Run>()
  readonly #events: RunEvent[] = []
  readonly #state = new Map<string, unknown>()
  readonly #streams = new Map<string, unknown[]>()
  readonly #audit: AuditEntry[] = []

  async putRun(run: Run): Promise<void> {
    this.#runs.set(run.runId, run)
  }

  async updateRun(runId: RunId, patch: Partial<Run>): Promise<void> {
    const existing = this.#runs.get(runId)
    if (!existing) throw new Error(`run not found: ${runId}`)
    this.#runs.set(runId, { ...existing, ...patch })
  }

  async getRun(runId: RunId): Promise<Run | null> {
    return this.#runs.get(runId) ?? null
  }

  async *listRuns(filter?: RunFilter): AsyncIterable<RunSummary> {
    for (const run of this.#runs.values()) {
      if (filter?.pipelineId && run.pipelineId !== filter.pipelineId) continue
      if (filter?.status && run.status !== filter.status) continue
      yield {
        runId: run.runId,
        pipelineId: run.pipelineId,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      }
    }
  }

  async appendEvent(event: RunEvent): Promise<void> {
    this.#events.push(event)
  }

  async *listEvents(
    runId: RunId,
    opts?: { since?: number; limit?: number },
  ): AsyncIterable<RunEvent> {
    let count = 0
    for (const ev of this.#events) {
      if ('runId' in ev && ev.runId !== runId) continue
      if (opts?.since !== undefined && 'at' in ev && (ev.at as number) <= opts.since) continue
      yield ev
      count++
      if (opts?.limit !== undefined && count >= opts.limit) break
    }
  }

  async getState<T>(namespace: string, key: string): Promise<T | undefined> {
    return this.#state.get(`${namespace}:${key}`) as T | undefined
  }

  async setState<T>(
    namespace: string,
    key: string,
    value: T,
    _opts?: StateSetOptions,
  ): Promise<void> {
    this.#state.set(`${namespace}:${key}`, value)
  }

  async deleteState(namespace: string, key: string): Promise<void> {
    this.#state.delete(`${namespace}:${key}`)
  }

  async *listState(namespace: string, prefix?: string): AsyncIterable<StateEntry> {
    const ns = `${namespace}:`
    for (const [k, v] of this.#state.entries()) {
      if (!k.startsWith(ns)) continue
      const shortKey = k.slice(ns.length)
      if (prefix !== undefined && !shortKey.startsWith(prefix)) continue
      yield { key: shortKey, value: v }
    }
  }

  async casState<T>(
    namespace: string,
    key: string,
    expected: T | undefined,
    next: T,
  ): Promise<boolean> {
    const current = await this.getState<T>(namespace, key)
    if (current !== expected) return false
    await this.setState(namespace, key, next)
    return true
  }

  async appendState(namespace: string, stream: string, entry: unknown): Promise<void> {
    const k = `${namespace}:${stream}`
    const arr = this.#streams.get(k) ?? []
    arr.push(entry)
    this.#streams.set(k, arr)
  }

  async *readState(
    namespace: string,
    stream: string,
    _opts?: StateReadOptions,
  ): AsyncIterable<unknown> {
    const arr = this.#streams.get(`${namespace}:${stream}`) ?? []
    for (const entry of arr) {
      yield entry
    }
  }

  async putAudit(entry: AuditEntry): Promise<void> {
    this.#audit.push(entry)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('P4 shape lock — MemorySecretResolver', () => {
  it('satisfies SecretResolver interface at runtime', async () => {
    const resolver: SecretResolver = new MemorySecretResolver()
    expect(await resolver.resolve('missing')).toBeUndefined()
  })

  it('resolves added secrets', async () => {
    const resolver = new MemorySecretResolver()
    resolver.add('API_KEY', 'secret-value')
    expect(await resolver.resolve('API_KEY')).toBe('secret-value')
  })

  it('enforces append-only semantics — throws on duplicate add', () => {
    const resolver = new MemorySecretResolver()
    resolver.add('KEY', 'v1')
    expect(() => resolver.add('KEY', 'v2')).toThrow(/already set/)
  })
})

describe('P4 shape lock — MinimalRunStore satisfies RunStore', () => {
  it('round-trips a run', async () => {
    const store: RunStore = new MinimalRunStore()
    await store.putRun({
      runId: 'r1',
      pipelineId: 'p',
      status: 'completed',
      startedAt: 100,
      completedAt: 200,
      steps: [],
      input: undefined,
    } as never)
    const got = await store.getRun('r1')
    expect(got?.runId).toBe('r1')
    expect(got?.status).toBe('completed')
  })

  it('lists runs with filter', async () => {
    const store = new MinimalRunStore()
    await store.putRun({
      runId: 'r1',
      pipelineId: 'p1',
      status: 'completed',
      startedAt: 1,
      steps: [],
      input: undefined,
    } as never)
    await store.putRun({
      runId: 'r2',
      pipelineId: 'p2',
      status: 'running',
      startedAt: 2,
      steps: [],
      input: undefined,
    } as never)
    const summaries: RunSummary[] = []
    for await (const s of store.listRuns({ pipelineId: 'p1' })) summaries.push(s)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.runId).toBe('r1')
  })

  it('stores and retrieves state with CAS', async () => {
    const store = new MinimalRunStore()
    await store.setState('ns', 'k', 'v1')
    expect(await store.getState('ns', 'k')).toBe('v1')
    expect(await store.casState('ns', 'k', 'v1', 'v2')).toBe(true)
    expect(await store.casState('ns', 'k', 'v1', 'v3')).toBe(false)
    expect(await store.getState('ns', 'k')).toBe('v2')
  })

  it('appends and reads stream state', async () => {
    const store = new MinimalRunStore()
    await store.appendState('ns', 'stream', { seq: 1 })
    await store.appendState('ns', 'stream', { seq: 2 })
    const entries: unknown[] = []
    for await (const e of store.readState('ns', 'stream')) entries.push(e)
    expect(entries).toEqual([{ seq: 1 }, { seq: 2 }])
  })

  it('records audit entries', async () => {
    const store = new MinimalRunStore()
    await store.putAudit?.({ actor: 'test', action: 'run.started', data: {}, at: Date.now() })
    // shape confirmed — no assertion needed beyond type-check pass
  })
})
