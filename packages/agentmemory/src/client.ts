import { AgentmemoryError } from './errors.js'
import type {
  ContextRequest,
  ContextResponse,
  GraphQueryRequest,
  GraphQueryResponse,
  HealthResponse,
  HookPayload,
  MemoryRecallRequest,
  MemoryRecallResponse,
  MemorySaveRequest,
  MemorySaveResponse,
  SessionEndRequest,
  SessionStartRequest,
  SessionsListRequest,
  SessionsListResponse,
  SmartSearchRequest,
  SmartSearchResponse,
} from './types.js'

export interface AgentmemoryClientOptions {
  /** Base URL of the agentmemory server, no trailing slash. */
  url: string
  /** Optional bearer secret; sent as `Authorization: Bearer <secret>`. */
  secret?: string
  /** Per-request timeout in milliseconds. Defaults to 3000ms. */
  timeoutMs?: number
  /** Override the global fetch implementation (used by tests). */
  fetch?: typeof globalThis.fetch
}

const BASE_PATH = '/agentmemory'

/**
 * Typed REST client for the agentmemory server. Methods throw
 * `AgentmemoryError` on transport / HTTP failure; callers (typically the
 * gateway-owned `AgentmemoryHandle` wrapper) decide whether to swallow or
 * surface.
 */
export class AgentmemoryClient {
  private readonly url: string
  private readonly secret?: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(opts: AgentmemoryClientOptions) {
    this.url = opts.url.replace(/\/+$/, '')
    if (opts.secret !== undefined) this.secret = opts.secret
    this.timeoutMs = opts.timeoutMs ?? 3000
    this.fetchImpl = opts.fetch ?? globalThis.fetch
  }

  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/health')
  }

  async startSession(req: SessionStartRequest): Promise<void> {
    await this.post('/session/start', req)
  }

  async endSession(req: SessionEndRequest): Promise<void> {
    await this.post('/session/end', req)
  }

  async observe(payload: HookPayload): Promise<void> {
    await this.post('/observe', payload)
  }

  async smartSearch(req: SmartSearchRequest): Promise<SmartSearchResponse> {
    const raw = await this.post<unknown>('/smart-search', req)
    return normalizeSearch(raw)
  }

  async context(req: ContextRequest): Promise<ContextResponse> {
    const raw = await this.post<unknown>('/context', req)
    return normalizeContext(raw)
  }

  async save(req: MemorySaveRequest): Promise<MemorySaveResponse> {
    const raw = await this.post<unknown>('/remember', req)
    return normalizeSave(raw)
  }

  async recall(req: MemoryRecallRequest): Promise<MemoryRecallResponse> {
    const raw = await this.get<unknown>(
      `/memories${buildQuery({ project: req.project, limit: req.limit, sessionId: req.session_id })}`,
    )
    return { hits: pickHits(raw, 'memories', 'hits', 'results') }
  }

  async sessions(req: SessionsListRequest): Promise<SessionsListResponse> {
    const raw = await this.get<unknown>(
      `/sessions${buildQuery({ project: req.project, limit: req.limit })}`,
    )
    return normalizeSessions(raw)
  }

  async graphQuery(req: GraphQueryRequest): Promise<GraphQueryResponse> {
    const raw = await this.post<unknown>('/graph/query', req)
    return normalizeGraph(raw)
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.secret !== undefined && this.secret.length > 0) {
      h.Authorization = `Bearer ${this.secret}`
    }
    return h
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const endpoint = `${this.url}${BASE_PATH}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const init: RequestInit = {
        method,
        headers: this.headers(),
        signal: controller.signal,
      }
      if (body !== undefined) init.body = JSON.stringify(body)
      const res = await this.fetchImpl(endpoint, init)
      if (!res.ok) {
        const text = await safeText(res)
        throw new AgentmemoryError(
          `agentmemory ${method} ${path} failed: ${res.status} ${text}`,
          endpoint,
          res.status,
        )
      }
      const len = res.headers.get('content-length')
      if (len === '0') return undefined as T
      const ct = res.headers.get('content-type') ?? ''
      if (!ct.includes('json')) return undefined as T
      return (await res.json()) as T
    } catch (err) {
      if (err instanceof AgentmemoryError) throw err
      const cause = err instanceof Error ? err : new Error(String(err))
      throw new AgentmemoryError(
        `agentmemory ${method} ${path} failed: ${cause.message}`,
        endpoint,
        undefined,
        { cause },
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return ''
  }
}

// Pull the first array found under one of `keys` (or a bare top-level array).
function pickArray(raw: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw !== null && typeof raw === 'object') {
    for (const k of keys) {
      const v = (raw as Record<string, unknown>)[k]
      if (Array.isArray(v)) return v
    }
  }
  return []
}

// Map one wire hit to a SmartSearchHit. The server's smart-search uses `obsId`
// and (in compact mode) omits `content`, carrying only `title`; the memories
// list carries `content`. Fall back across all of these so neither id nor the
// recall text comes out empty.
function toHit(h: unknown) {
  const x = (h ?? {}) as Record<string, unknown>
  return {
    id: String(x.id ?? x.obsId ?? ''),
    title: String(x.title ?? ''),
    content: String(x.content ?? x.narrative ?? x.title ?? ''),
    ...(typeof x.score === 'number' ? { score: x.score } : {}),
    ...(Array.isArray(x.concepts) ? { concepts: x.concepts.map(String) } : {}),
  }
}

function pickHits(raw: unknown, ...keys: string[]): SmartSearchResponse['hits'] {
  return pickArray(raw, keys).map(toHit)
}

function normalizeSearch(raw: unknown): SmartSearchResponse {
  return { hits: pickArray(raw, ['hits', 'results']).map(toHit) }
}

function normalizeContext(raw: unknown): ContextResponse {
  if (raw === null || typeof raw !== 'object') return { text: '' }
  const r = raw as {
    text?: unknown
    context?: unknown
    tokenEstimate?: unknown
    token_estimate?: unknown
    tokens?: unknown
  }
  const text = typeof r.text === 'string' ? r.text : typeof r.context === 'string' ? r.context : ''
  const est =
    typeof r.tokenEstimate === 'number'
      ? r.tokenEstimate
      : typeof r.token_estimate === 'number'
        ? r.token_estimate
        : r.tokens
  return typeof est === 'number' ? { text, tokenEstimate: est } : { text }
}

function normalizeSave(raw: unknown): MemorySaveResponse {
  if (raw === null || typeof raw !== 'object') return { id: '' }
  const r = raw as { id?: unknown; memory_id?: unknown; memory?: unknown }
  const inner =
    r.memory !== null && typeof r.memory === 'object' ? (r.memory as { id?: unknown }) : undefined
  return { id: String(inner?.id ?? r.id ?? r.memory_id ?? '') }
}

function normalizeSessions(raw: unknown): SessionsListResponse {
  const sessions = pickArray(raw, ['sessions']).map((s: unknown) => {
    const x = (s ?? {}) as Record<string, unknown>
    const rawStart = x.startedAt ?? x.started_at
    const startedAt =
      typeof rawStart === 'number'
        ? rawStart
        : typeof rawStart === 'string' && !Number.isNaN(Date.parse(rawStart))
          ? Date.parse(rawStart)
          : undefined
    return {
      id: String(x.id ?? x.sessionId ?? x.session_id ?? ''),
      ...(typeof x.title === 'string' ? { title: x.title } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(Array.isArray(x.highlights) ? { highlights: x.highlights.map(String) } : {}),
    }
  })
  return { sessions }
}

function normalizeGraph(raw: unknown): GraphQueryResponse {
  if (raw === null || typeof raw !== 'object') return { nodes: [], edges: [] }
  const r = raw as { nodes?: unknown; edges?: unknown }
  const nodes = (Array.isArray(r.nodes) ? r.nodes : []).map((n: unknown) => {
    const x = (n ?? {}) as Record<string, unknown>
    return {
      id: String(x.id ?? ''),
      label: String(x.label ?? x.name ?? ''),
      ...(typeof x.kind === 'string' ? { kind: x.kind } : {}),
    }
  })
  const edges = (Array.isArray(r.edges) ? r.edges : []).map((e: unknown) => {
    const x = (e ?? {}) as Record<string, unknown>
    return {
      from: String(x.from ?? x.source ?? ''),
      to: String(x.to ?? x.target ?? ''),
      ...(typeof x.relation === 'string' ? { relation: x.relation } : {}),
    }
  })
  return { nodes, edges }
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const pairs: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return pairs.length > 0 ? `?${pairs.join('&')}` : ''
}
