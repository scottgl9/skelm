import type {
  BackendCapabilities,
  BackendContext,
  InferRequest,
  InferResponse,
  SkelmBackend,
  Usage,
} from '@skelm/core'

/**
 * Configuration for the Ollama / OpenAI-compatible local backend.
 *
 * Defaults target a local Ollama install on http://127.0.0.1:11434. Any other
 * server that speaks the OpenAI /v1/chat/completions wire format works too —
 * vLLM, LM Studio, llama.cpp's openai-compatible mode, etc. Pass `baseUrl`.
 */
export interface OllamaBackendOptions {
  id?: string
  label?: string
  /** Default `http://127.0.0.1:11434/v1`. Set to override. */
  baseUrl?: string
  /** Default model when an `llm()`/`agent()` step does not pin one. */
  model?: string
  /** Optional bearer token; most local servers don't need one. */
  apiKey?: string
  /** Override fetch — used by tests. */
  fetch?: typeof fetch
}

/**
 * Capability negotiation: tool-use and structured-output support varies wildly
 * across local models and runtimes. We advertise the conservative defaults and
 * fail at request time with a typed error rather than silently degrading.
 */
const DEFAULT_CAPABILITIES: BackendCapabilities = {
  prompt: true,
  streaming: false,
  sessionLifecycle: false,
  mcp: false,
  skills: false,
  modelSelection: true,
  toolPermissions: 'unsupported',
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1'
const DEFAULT_MODEL = 'llama3.2'

export function createOllamaBackend(opts: OllamaBackendOptions = {}): SkelmBackend {
  const fetcher = opts.fetch ?? fetch
  const backend: SkelmBackend = {
    id: opts.id ?? 'ollama',
    label: opts.label ?? 'Ollama',
    capabilities: DEFAULT_CAPABILITIES,
    async infer(req: InferRequest, ctx: BackendContext): Promise<InferResponse> {
      const url = new URL('chat/completions', baseUrl(opts.baseUrl))
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const apiKey = opts.apiKey ?? process.env.OLLAMA_API_KEY
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const response = await fetcher(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: req.model ?? opts.model ?? DEFAULT_MODEL,
          messages: buildMessages(req),
          ...(req.temperature !== undefined && { temperature: req.temperature }),
          ...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
          ...(req.outputSchema !== undefined && { response_format: { type: 'json_object' } }),
          stream: false,
        }),
        signal: ctx.signal,
      })
      if (!response.ok) {
        throw new Error(`Ollama backend request failed (${response.status} ${response.statusText})`)
      }
      const body = (await response.json()) as ChatCompletionResponse
      const content = extractContent(body)
      const usage = toUsage(body.usage)
      if (req.outputSchema !== undefined) {
        return {
          text: content,
          structured: parseJson(content),
          ...(usage !== undefined && { usage }),
        }
      }
      return {
        text: content,
        ...(usage !== undefined && { usage }),
      }
    },
  }
  return backend
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function baseUrl(url?: string): string {
  const value = url ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL
  return value.endsWith('/') ? value : `${value}/`
}

function buildMessages(req: InferRequest): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = []
  if (req.system !== undefined) messages.push({ role: 'system', content: req.system })
  for (const m of req.messages) messages.push({ role: m.role, content: m.content })
  if (req.outputSchema !== undefined) {
    messages.push({
      role: 'system',
      content: 'Return only valid JSON matching the requested output shape.',
    })
  }
  return messages
}

function extractContent(body: ChatCompletionResponse): string {
  const c = body.choices?.[0]?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
  }
  throw new Error('Ollama response did not include message content')
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch (err) {
    throw new Error(`Ollama backend returned invalid JSON: ${(err as Error).message}`)
  }
}

function toUsage(usage: ChatCompletionResponse['usage']): Usage | undefined {
  if (!usage) return undefined
  return {
    ...(usage.prompt_tokens !== undefined && { inputTokens: usage.prompt_tokens }),
    ...(usage.completion_tokens !== undefined && { outputTokens: usage.completion_tokens }),
    ...(usage.total_tokens !== undefined && {
      extras: { totalTokens: usage.total_tokens },
    }),
  }
}
