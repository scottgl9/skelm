import type {
  AgentmemoryContextBlock,
  AgentmemoryGraphResult,
  AgentmemoryHandle,
  AgentmemoryOperation,
  AgentmemoryRecallResult,
  AgentmemorySaveResult,
  AgentmemorySearchResult,
  AgentmemorySessionsResult,
  EnforceDecision,
  PermissionDimension,
} from '@skelm/core'
import type { AgentmemoryClient } from './client.js'
import { AgentmemoryError } from './errors.js'

export interface AgentmemoryHandleOptions {
  client: AgentmemoryClient
  /**
   * Per-op enforcer. Returns an EnforceDecision; when `allow: false` the
   * call is short-circuited and a `permission.denied` event is published.
   */
  canUseAgentmemory: (op: AgentmemoryOperation) => EnforceDecision
  /** Audit hook: called with one of `agentmemory.{observe,search,session.start,session.end,context,save,recall,sessions,graph}`. */
  audit?: (event: AgentmemoryAuditEvent) => void
  /** Permission-denied / error events for the run's EventBus. */
  events?: (event: AgentmemoryRuntimeEvent) => void
  /** Stable project string forwarded to the server when callers don't supply one. */
  defaultProject?: string
  runId?: string
  stepId?: string
}

export type AgentmemoryAuditEvent =
  | { type: 'agentmemory.session.start'; sessionId: string; at: number }
  | { type: 'agentmemory.session.end'; sessionId: string; at: number }
  | { type: 'agentmemory.observe'; sessionId: string; hookType: string; at: number }
  | { type: 'agentmemory.search'; query: string; hits: number; at: number }
  | { type: 'agentmemory.context'; query: string; at: number }
  | { type: 'agentmemory.save'; id: string; at: number }
  | { type: 'agentmemory.recall'; hits: number; at: number }
  | { type: 'agentmemory.sessions'; count: number; at: number }
  | { type: 'agentmemory.graph'; query: string; nodes: number; at: number }

export type AgentmemoryRuntimeEvent =
  | {
      type: 'permission.denied'
      runId?: string
      stepId?: string
      dimension: PermissionDimension
      detail: string
      at: number
    }
  | {
      type: 'agentmemory.error'
      runId?: string
      stepId?: string
      op: AgentmemoryOperation
      message: string
      status?: number
      at: number
    }

/**
 * Gateway-owned implementation of `AgentmemoryHandle`. Wraps an
 * `AgentmemoryClient` with permission enforcement, audit emission, and
 * fire-and-forget error swallowing.
 *
 * Backends must use this (or another `AgentmemoryHandle`) — they never
 * touch the raw client. The runtime never throws out of observe/search/etc;
 * failures are reported via the events callback.
 */
export function createAgentmemoryHandle(opts: AgentmemoryHandleOptions): AgentmemoryHandle {
  const { client, canUseAgentmemory, audit, events, defaultProject } = opts

  function denied(op: AgentmemoryOperation, dimension: PermissionDimension): void {
    if (events) {
      events({
        type: 'permission.denied',
        ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
        ...(opts.stepId !== undefined ? { stepId: opts.stepId } : {}),
        dimension,
        detail: `agentmemory.${op} denied by policy`,
        at: Date.now(),
      })
    }
  }

  function reportError(op: AgentmemoryOperation, err: unknown): void {
    if (!events) return
    const e = err instanceof AgentmemoryError ? err : undefined
    events({
      type: 'agentmemory.error',
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts.stepId !== undefined ? { stepId: opts.stepId } : {}),
      op,
      message: err instanceof Error ? err.message : String(err),
      ...(e?.status !== undefined ? { status: e.status } : {}),
      at: Date.now(),
    })
  }

  return {
    async startSession(input) {
      const d = canUseAgentmemory('session')
      if (!d.allow) return denied('session', d.dimension)
      try {
        await client.startSession({
          sessionId: input.sessionId,
          project: input.project ?? defaultProject ?? input.cwd ?? '',
          cwd: input.cwd ?? defaultProject ?? '',
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
        })
        audit?.({ type: 'agentmemory.session.start', sessionId: input.sessionId, at: Date.now() })
      } catch (err) {
        reportError('session', err)
      }
    },
    async endSession(input) {
      const d = canUseAgentmemory('session')
      if (!d.allow) return denied('session', d.dimension)
      try {
        await client.endSession({ sessionId: input.sessionId })
        audit?.({ type: 'agentmemory.session.end', sessionId: input.sessionId, at: Date.now() })
      } catch (err) {
        reportError('session', err)
      }
    },
    async observe(input) {
      const d = canUseAgentmemory('observe')
      if (!d.allow) return denied('observe', d.dimension)
      try {
        await client.observe({
          hookType: input.hookType,
          sessionId: input.sessionId,
          project: input.project ?? defaultProject ?? '',
          cwd: input.cwd ?? defaultProject ?? '',
          timestamp: new Date().toISOString(),
          data: input.data,
        })
        audit?.({
          type: 'agentmemory.observe',
          sessionId: input.sessionId,
          hookType: input.hookType,
          at: Date.now(),
        })
      } catch (err) {
        reportError('observe', err)
      }
    },
    async smartSearch(input): Promise<AgentmemorySearchResult> {
      const d = canUseAgentmemory('search')
      if (!d.allow) {
        denied('search', d.dimension)
        return { hits: [] }
      }
      try {
        const res = await client.smartSearch({
          query: input.query,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        })
        audit?.({
          type: 'agentmemory.search',
          query: input.query,
          hits: res.hits.length,
          at: Date.now(),
        })
        return { hits: res.hits }
      } catch (err) {
        reportError('search', err)
        return { hits: [] }
      }
    },
    async context(input): Promise<AgentmemoryContextBlock> {
      const d = canUseAgentmemory('context')
      if (!d.allow) {
        denied('context', d.dimension)
        return { text: '' }
      }
      try {
        const res = await client.context({
          sessionId: input.sessionId ?? '',
          project: input.project ?? defaultProject ?? '',
          query: input.query,
          ...(input.tokenBudget !== undefined ? { token_budget: input.tokenBudget } : {}),
        })
        audit?.({ type: 'agentmemory.context', query: input.query, at: Date.now() })
        return res.tokenEstimate !== undefined
          ? { text: res.text, tokenEstimate: res.tokenEstimate }
          : { text: res.text }
      } catch (err) {
        reportError('context', err)
        return { text: '' }
      }
    },
    async save(input): Promise<AgentmemorySaveResult> {
      const d = canUseAgentmemory('save')
      if (!d.allow) {
        denied('save', d.dimension)
        return { id: '' }
      }
      try {
        const res = await client.save({
          project: input.project ?? defaultProject ?? '',
          title: input.title,
          content: input.content,
          ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
          ...(input.concepts !== undefined ? { concepts: input.concepts } : {}),
        })
        audit?.({ type: 'agentmemory.save', id: res.id, at: Date.now() })
        return { id: res.id }
      } catch (err) {
        reportError('save', err)
        return { id: '' }
      }
    },
    async recall(input): Promise<AgentmemoryRecallResult> {
      const d = canUseAgentmemory('recall')
      if (!d.allow) {
        denied('recall', d.dimension)
        return { hits: [] }
      }
      try {
        const res = await client.recall({
          project: input.project ?? defaultProject ?? '',
          ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        audit?.({ type: 'agentmemory.recall', hits: res.hits.length, at: Date.now() })
        return { hits: res.hits }
      } catch (err) {
        reportError('recall', err)
        return { hits: [] }
      }
    },
    async sessions(input): Promise<AgentmemorySessionsResult> {
      const d = canUseAgentmemory('recall')
      if (!d.allow) {
        denied('recall', d.dimension)
        return { sessions: [] }
      }
      try {
        const res = await client.sessions({
          project: input.project ?? defaultProject ?? '',
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        audit?.({ type: 'agentmemory.sessions', count: res.sessions.length, at: Date.now() })
        return { sessions: res.sessions }
      } catch (err) {
        reportError('recall', err)
        return { sessions: [] }
      }
    },
    async graphQuery(input): Promise<AgentmemoryGraphResult> {
      const d = canUseAgentmemory('graph')
      if (!d.allow) {
        denied('graph', d.dimension)
        return { nodes: [], edges: [] }
      }
      try {
        const res = await client.graphQuery({
          project: input.project ?? defaultProject ?? '',
          query: input.query,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        audit?.({
          type: 'agentmemory.graph',
          query: input.query,
          nodes: res.nodes.length,
          at: Date.now(),
        })
        return { nodes: res.nodes, edges: res.edges }
      } catch (err) {
        reportError('graph', err)
        return { nodes: [], edges: [] }
      }
    },
  }
}
