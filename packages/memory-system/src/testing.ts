// Deterministic fakes for driving the memory-management workflows without a
// real agentmemory backend or run store. Shipped (not test-only) so the
// package self-test can reuse them.

import { createAgentmemoryHandle } from '@skelm/agentmemory'
import { type AgentmemoryOperation, TrustEnforcer, resolvePermissions } from '@skelm/core'
import { type MemoryWorkflowId, WORKFLOW_PERMISSIONS } from './permissions.js'
import type { MemoryClient, MemoryRecord, State } from './types.js'

/** Records every agentmemory op the workflow attempts, with its arguments. */
export interface MemoryCall {
  readonly op: AgentmemoryOperation
  readonly args: unknown
}

export interface FakeMemoryOptions {
  /** Hits returned by recall(). */
  readonly recall?: readonly MemoryRecord[]
  /** Hits returned by smartSearch(), keyed by query (or `*` for any). */
  readonly search?: Readonly<Record<string, readonly MemoryRecord[]>>
  /** Nodes/edges returned by graphQuery(). */
  readonly graph?: {
    nodes?: readonly { id: string; label: string }[]
    edges?: readonly { from: string; to: string }[]
  }
}

export interface FakeMemory extends MemoryClient {
  /** All ops attempted, including those denied at the permission gate. */
  readonly calls: MemoryCall[]
  /** Save calls that actually reached the fake backend (i.e. not denied). */
  readonly saved: { title: string; content: string; concepts?: readonly string[] }[]
}

/**
 * Build a `FakeMemory` whose underlying ops are recorded, wrapped in the real
 * `createAgentmemoryHandle` enforcement layer for the given workflow's declared
 * ceiling. A denied op short-circuits in the handle before reaching the fake,
 * so `saved` proves whether a write was actually permitted.
 */
export function makeFakeMemory(
  workflow: MemoryWorkflowId,
  opts: FakeMemoryOptions = {},
): FakeMemory {
  const calls: MemoryCall[] = []
  const saved: FakeMemory['saved'] = []
  const record = (op: AgentmemoryOperation, args: unknown) => calls.push({ op, args })

  const backend: MemoryClient = {
    async startSession(args) {
      record('session', args)
    },
    async endSession(args) {
      record('session', args)
    },
    async observe(args) {
      record('observe', args)
    },
    async smartSearch(args) {
      record('search', args)
      const map = opts.search ?? {}
      const hits = map[args.query] ?? map['*'] ?? []
      return { hits }
    },
    async context(args) {
      record('context', args)
      return { text: '' }
    },
    async save(args) {
      record('save', args)
      saved.push({
        title: args.title,
        content: args.content,
        ...(args.concepts !== undefined ? { concepts: args.concepts } : {}),
      })
      return { id: `mem-${saved.length}` }
    },
    async recall(args) {
      record('recall', args)
      return { hits: opts.recall ?? [] }
    },
    async sessions(args) {
      record('recall', args)
      return { sessions: [] }
    },
    async graphQuery(args) {
      record('graph', args)
      return { nodes: opts.graph?.nodes ?? [], edges: opts.graph?.edges ?? [] }
    },
  }

  const policy = resolvePermissions(undefined, WORKFLOW_PERMISSIONS[workflow])
  const enforcer = new TrustEnforcer(policy)
  const handle = createAgentmemoryHandle({
    client: backend as never,
    canUseAgentmemory: (op: AgentmemoryOperation) => enforcer.canUseAgentmemory(op),
    defaultProject: 'test',
  })

  return Object.assign(handle as FakeMemory, { calls, saved })
}

/** Minimal in-memory `State` covering get/set/delete/list and the helpers used. */
export function makeFakeState(seed: Record<string, unknown> = {}): State {
  const store = new Map<string, unknown>(Object.entries(seed))
  const self: State = {
    async get<T>(key: string) {
      return store.get(key) as T | undefined
    },
    async set<T>(key: string, value: T) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
    async *list(prefix?: string) {
      for (const [key, value] of store) {
        if (prefix === undefined || key.startsWith(prefix)) yield { key, value }
      }
    },
    async cas<T>(key: string, expected: T | undefined, next: T) {
      const current = store.get(key) as T | undefined
      if (current !== expected) return false
      store.set(key, next)
      return true
    },
    async append(stream: string, entry: unknown) {
      const arr = (store.get(`stream:${stream}`) as unknown[] | undefined) ?? []
      arr.push(entry)
      store.set(`stream:${stream}`, arr)
    },
    async *read(stream: string) {
      const arr = (store.get(`stream:${stream}`) as unknown[] | undefined) ?? []
      yield* arr
    },
    scope() {
      return self
    },
  }
  return self
}

/** Fixed clock for deterministic age/staleness logic. */
export function fixedClock(at: number): () => number {
  return () => at
}
