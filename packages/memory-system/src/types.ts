import type { AgentmemoryHandle, Context } from '@skelm/core'

/** The durable-state handle exposed on a step `Context` (not separately exported by core). */
export type State = Context['state']

/**
 * The narrow agentmemory surface the memory-management workflows use. It is a
 * structural subset of `@skelm/core`'s `AgentmemoryHandle` so the workflows can
 * be driven by the real gateway-wired handle in production and by a fake in
 * tests. Permission enforcement still lives in the handle: a workflow that was
 * not granted `allowSave` gets a handle whose `save` short-circuits to a denied
 * no-op, so calling it here cannot bypass the policy.
 */
export type MemoryClient = AgentmemoryHandle

/**
 * Produces a condensed summary of session text. In production this is backed by
 * an `infer()` / agent turn; tests inject a deterministic stub. The contract is
 * intentionally tiny so a workflow never depends on a concrete backend.
 */
export interface Summarizer {
  summarize(input: { text: string; instructions?: string }): Promise<string>
}

/** Monotonic clock; injectable so time-based logic (TTL, staleness) is testable. */
export type Clock = () => number

/** Structured workflow log line; never carries secret values. */
export interface MemoryLogEntry {
  readonly workflow: string
  readonly message: string
  readonly data?: Readonly<Record<string, unknown>>
}

export type MemoryLogger = (entry: MemoryLogEntry) => void

/**
 * Dependencies every memory-management workflow operates over. Assembled once
 * per run — by the package's pipeline entrypoints in production (from config +
 * the gateway-wired handle) and directly by tests with fakes.
 */
export interface MemorySystemDeps {
  /** Permission-gated agentmemory handle. */
  readonly memory: MemoryClient
  /** Durable workflow state (cursors, archive index, audit records). */
  readonly state: State
  /** Stable project string forwarded to agentmemory ops. */
  readonly project: string
  /** Optional summarizer; required only by session summarization. */
  readonly summarizer?: Summarizer
  readonly now?: Clock
  readonly log?: MemoryLogger
}

/** A memory record as the workflows reason about it (subset of a search hit). */
export interface MemoryRecord {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly score?: number
  readonly concepts?: readonly string[]
}

/** Shared result envelope so callers (and the self-test) can assert outcomes. */
export interface WorkflowOutcome {
  readonly workflow: string
  readonly ok: boolean
  /** Per-workflow counters (e.g. `{ pruned: 3 }`); empty when nothing matched. */
  readonly stats: Readonly<Record<string, number>>
  /** Operation names that were denied by policy during the run, if any. */
  readonly denied?: readonly string[]
}
