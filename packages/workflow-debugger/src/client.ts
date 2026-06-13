import type { RunEvent, WorkflowGraph } from '@skelm/core'
import type { ArtifactSummary, AuditRow, GatewayDebugClient, GraphEditPreview } from './types.js'

export interface GatewayDebugHttpClientOptions {
  /** Gateway base URL, no trailing slash. */
  url: string
  /** Bearer token VALUE, resolved by the caller from a token reference. */
  token?: string
  /** Per-request timeout in milliseconds. Defaults to 5000ms. */
  timeoutMs?: number
  /** Override the global fetch implementation (used by tests). */
  fetch?: typeof globalThis.fetch
}

/**
 * Read-only HTTP client over the gateway run/audit/artifact surface, plus the
 * single dry-run apply call. Authenticates by bearer; the caller resolves the
 * token VALUE from a reference (env/secret name) and passes it here — this
 * client never reads a secret store.
 *
 * The only mutating endpoint it can reach is the source-apply route, and it is
 * called exclusively with `dryRun: true`: the client cannot write source.
 */
export class GatewayDebugHttpClient implements GatewayDebugClient {
  private readonly url: string
  private readonly token?: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(opts: GatewayDebugHttpClientOptions) {
    this.url = opts.url.replace(/\/+$/, '')
    if (opts.token !== undefined) this.token = opts.token
    this.timeoutMs = opts.timeoutMs ?? 5000
    this.fetchImpl = opts.fetch ?? globalThis.fetch
  }

  async getRun(runId: string): Promise<{ pipelineId?: string; status?: string } | null> {
    const raw = await this.get<unknown>(`/runs/${encodeURIComponent(runId)}`)
    if (raw === null || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    const pipelineId = typeof r.pipelineId === 'string' ? r.pipelineId : undefined
    const status = typeof r.status === 'string' ? r.status : undefined
    return {
      ...(pipelineId !== undefined ? { pipelineId } : {}),
      ...(status !== undefined ? { status } : {}),
    }
  }

  async getEvents(runId: string): Promise<readonly RunEvent[]> {
    const raw = await this.get<unknown>(`/runs/${encodeURIComponent(runId)}/events`)
    const events = pickArray(raw, 'events')
    return events.filter((e): e is RunEvent => e !== null && typeof e === 'object')
  }

  async getAudit(runId: string): Promise<readonly AuditRow[]> {
    const raw = await this.get<unknown>(`/audit?runId=${encodeURIComponent(runId)}`)
    const entries = pickArray(raw, 'entries')
    return entries
      .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
      .map(toAuditRow)
  }

  async getArtifacts(runId: string): Promise<readonly ArtifactSummary[]> {
    const raw = await this.get<unknown>(`/runs/${encodeURIComponent(runId)}/artifacts`)
    const items = Array.isArray(raw) ? raw : pickArray(raw, 'artifacts')
    return items
      .filter((a): a is Record<string, unknown> => a !== null && typeof a === 'object')
      .map(toArtifactSummary)
  }

  async getWorkflowGraph(workflowId: string): Promise<WorkflowGraph | null> {
    const raw = await this.get<unknown>(`/v1/workflows/${encodeURIComponent(workflowId)}/graph`)
    if (raw === null || typeof raw !== 'object') return null
    return raw as WorkflowGraph
  }

  async applyGraphEditsDryRun(
    workflowId: string,
    edits: readonly unknown[],
  ): Promise<GraphEditPreview> {
    const raw = await this.post<unknown>(
      `/v1/workflows/${encodeURIComponent(workflowId)}/source/apply`,
      { edits, dryRun: true },
    )
    const r = (raw ?? {}) as Record<string, unknown>
    return {
      ok: r.ok === true,
      applied: false,
      dryRun: true,
      ...(typeof r.diff === 'string' ? { diff: r.diff } : {}),
      ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token !== undefined && this.token.length > 0) {
      h.Authorization = `Bearer ${this.token}`
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
    const endpoint = `${this.url}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const init: RequestInit = { method, headers: this.headers(), signal: controller.signal }
      if (body !== undefined) init.body = JSON.stringify(body)
      const res = await this.fetchImpl(endpoint, init)
      if (!res.ok) {
        // The error text can echo back a secret-shaped request; cap it and let
        // the redactor scrub it downstream. Do not include request headers.
        const text = (await safeText(res)).slice(0, 300)
        throw new Error(`gateway ${method} ${path} failed: ${res.status} ${text}`)
      }
      const ct = res.headers.get('content-type') ?? ''
      if (!ct.includes('json')) return undefined as T
      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

function pickArray(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw !== null && typeof raw === 'object') {
    const v = (raw as Record<string, unknown>)[key]
    if (Array.isArray(v)) return v
  }
  return []
}

function toAuditRow(e: Record<string, unknown>): AuditRow {
  return {
    ...(typeof e.seq === 'number' ? { seq: e.seq } : {}),
    ...(typeof e.runId === 'string' ? { runId: e.runId } : {}),
    actor: String(e.actor ?? ''),
    action: String(e.action ?? ''),
    data: e.data,
    ...(typeof e.at === 'number' || typeof e.at === 'string' ? { at: e.at } : {}),
  }
}

function toArtifactSummary(a: Record<string, unknown>): ArtifactSummary {
  return {
    id: String(a.id ?? a.artifactId ?? ''),
    name: String(a.name ?? ''),
    mimeType: String(a.mimeType ?? a.mime_type ?? 'application/octet-stream'),
    ...(typeof a.stepId === 'string' ? { stepId: a.stepId } : {}),
    ...(typeof a.sizeBytes === 'number' ? { sizeBytes: a.sizeBytes } : {}),
  }
}
