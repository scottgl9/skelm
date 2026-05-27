import { AgentmemoryError } from './errors.js'
import type {
  ContextRequest,
  ContextResponse,
  HealthResponse,
  HookPayload,
  SessionEndRequest,
  SessionStartRequest,
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

function normalizeSearch(raw: unknown): SmartSearchResponse {
  if (raw === null || typeof raw !== 'object') return { hits: [] }
  const r = raw as { hits?: unknown; results?: unknown }
  const list = Array.isArray(r.hits) ? r.hits : Array.isArray(r.results) ? r.results : []
  const hits = list.map((h: unknown) => {
    const x = (h ?? {}) as Record<string, unknown>
    return {
      id: String(x.id ?? ''),
      title: String(x.title ?? ''),
      content: String(x.content ?? x.narrative ?? ''),
      ...(typeof x.score === 'number' ? { score: x.score } : {}),
      ...(Array.isArray(x.concepts) ? { concepts: x.concepts.map(String) } : {}),
    }
  })
  return { hits }
}

function normalizeContext(raw: unknown): ContextResponse {
  if (raw === null || typeof raw !== 'object') return { text: '' }
  const r = raw as { text?: unknown; tokenEstimate?: unknown; token_estimate?: unknown }
  const text = typeof r.text === 'string' ? r.text : ''
  const est = typeof r.tokenEstimate === 'number' ? r.tokenEstimate : r.token_estimate
  return typeof est === 'number' ? { text, tokenEstimate: est } : { text }
}
