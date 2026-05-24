import { inspect } from 'node:util'
import {
  type BackendCapabilities,
  BackendConfigError,
  type BackendContext,
  type InferRequest,
  type InferResponse,
  type SkelmBackend,
  type Usage,
} from '../backend.js'
import { isMultimodal } from '../content.js'
import type { SecretResolver } from '../enforcement/index.js'

export interface OpenAIBackendOptions {
  id?: string
  label?: string
  /** Inline API key. Wins over secretResolver and process.env. */
  apiKey?: string
  baseUrl?: string
  model?: string
  fetch?: typeof fetch
  /**
   * Optional SecretResolver. When provided and `apiKey` is unset, the
   * backend resolves `OPENAI_API_KEY` through the resolver instead of
   * reading process.env directly. Pass the gateway's resolver here so
   * secret access stays audited; omit for embedded callers that want
   * the existing env fallback.
   */
  secretResolver?: SecretResolver
}

type ApiKeySource = 'explicit' | 'resolver' | 'env'

interface OpenAIBackendDebug {
  apiKey: string | null
  effective: ApiKeySource | null
  getApiKey(): Promise<string>
}

export function createOpenAIBackend(opts: OpenAIBackendOptions = {}): SkelmBackend {
  const envKey = normalizeApiKey(process.env.OPENAI_API_KEY)
  const resolverPromise =
    opts.apiKey === undefined && opts.secretResolver !== undefined
      ? opts.secretResolver.resolve('OPENAI_API_KEY')
      : undefined
  const peekedResolverKey = resolverPromise ? peekResolvedSecret(resolverPromise) : null
  if (opts.apiKey === undefined && resolverPromise === undefined && envKey === undefined) {
    throw new BackendConfigError('OpenAI backend requires an API key (OPENAI_API_KEY)', 'openai')
  }
  const debug: OpenAIBackendDebug = {
    apiKey: opts.apiKey ?? peekedResolverKey ?? envKey ?? null,
    effective: opts.apiKey ? 'explicit' : peekedResolverKey ? 'resolver' : envKey ? 'env' : null,
    async getApiKey(): Promise<string> {
      const resolved = await resolveApiKey(opts.apiKey, resolverPromise, envKey)
      debug.apiKey = resolved
      debug.effective = opts.apiKey ? 'explicit' : resolved === envKey ? 'env' : 'resolver'
      return resolved
    },
  }
  const capabilities: BackendCapabilities = {
    prompt: true,
    streaming: false,
    sessionLifecycle: false,
    mcp: false,
    skills: false,
    modelSelection: true,
    toolPermissions: 'unsupported',
    vision: true,
  }

  const backend: SkelmBackend & OpenAIBackendDebug = {
    id: opts.id ?? 'openai',
    label: opts.label ?? 'OpenAI',
    capabilities,
    get apiKey() {
      return debug.apiKey
    },
    get effective() {
      return debug.effective
    },
    getApiKey: debug.getApiKey,
    async infer(req: InferRequest, ctx: BackendContext): Promise<InferResponse> {
      const apiKey = await debug.getApiKey()
      const response = await (opts.fetch ?? fetch)(
        new URL('/chat/completions', baseUrl(opts.baseUrl)),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: req.model ?? opts.model ?? 'gpt-4.1-mini',
            messages: buildMessages(req),
            ...(req.temperature !== undefined && { temperature: req.temperature }),
            ...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
            ...(req.outputSchema !== undefined && { response_format: { type: 'json_object' } }),
          }),
          signal: ctx.signal,
        },
      )
      if (!response.ok) {
        throw new Error(`OpenAI request failed (${response.status} ${response.statusText})`)
      }
      const rawBody: unknown = await response.json()
      const body = assertOpenAIResponse(rawBody)
      const content = extractMessageContent(body)
      const usage = toUsage(body.usage)
      if (req.outputSchema !== undefined) {
        return {
          text: content,
          structured: parseJsonContent(content),
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

interface OpenAIChatCompletionResponse {
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

/**
 * Defensive shape check on the parsed JSON body. The OpenAI API
 * generally returns the documented shape, but a misrouted endpoint, a
 * proxy injecting an error envelope, or a future API change can yield
 * an unexpected payload. Reject loudly here rather than letting the
 * downstream extract silently return empty content.
 */
function assertOpenAIResponse(body: unknown): OpenAIChatCompletionResponse {
  if (typeof body !== 'object' || body === null) {
    throw new Error('OpenAI response was not a JSON object')
  }
  const b = body as Record<string, unknown>
  if (b.choices !== undefined && !Array.isArray(b.choices)) {
    throw new Error("OpenAI response 'choices' was not an array")
  }
  if (b.usage !== undefined && (typeof b.usage !== 'object' || b.usage === null)) {
    throw new Error("OpenAI response 'usage' was not an object")
  }
  return body as OpenAIChatCompletionResponse
}

async function resolveApiKey(
  explicit: string | undefined,
  resolverPromise: Promise<string | undefined> | undefined,
  envKey: string | undefined,
): Promise<string> {
  if (explicit) return explicit
  if (resolverPromise !== undefined) {
    const resolved = await resolverPromise
    if (resolved) return resolved
  }
  // Construction-time guard ensures envKey is defined here; this satisfies
  // the return type without a redundant throw.
  return envKey as string
}

function peekResolvedSecret(resolverPromise: Promise<string | undefined>): string | null {
  try {
    const raw = inspect(resolverPromise)
    const match = raw.match(/^Promise \{ '([^']*)' \}$/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function normalizeApiKey(value: string | undefined): string | undefined {
  return value === undefined || value === '' || value === 'undefined' ? undefined : value
}

function baseUrl(url?: string): string {
  const value = url ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
  return value.endsWith('/') ? value : `${value}/`
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

function buildMessages(
  req: InferRequest,
): Array<{ role: string; content: string | OpenAIContentPart[] }> {
  const messages: Array<{ role: string; content: string | OpenAIContentPart[] }> = []
  if (req.system !== undefined) {
    messages.push({ role: 'system', content: req.system })
  }
  for (const message of req.messages) {
    messages.push({ role: message.role, content: toOpenAIContent(message.content) })
  }
  if (req.outputSchema !== undefined) {
    messages.push({
      role: 'system',
      content: 'Return only valid JSON matching the requested output shape.',
    })
  }
  return messages
}

function toOpenAIContent(
  content: InferRequest['messages'][number]['content'],
): string | OpenAIContentPart[] {
  if (!isMultimodal(content)) return content
  const parts: OpenAIContentPart[] = []
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text })
    } else {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${part.mimeType};base64,${part.data}` },
      })
    }
  }
  return parts
}

function extractMessageContent(body: OpenAIChatCompletionResponse): string {
  const content = body.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
  }
  throw new Error('OpenAI response did not include message content')
}

function parseJsonContent(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch (err) {
    throw new Error(`OpenAI backend returned invalid JSON: ${(err as Error).message}`)
  }
}

function toUsage(usage: OpenAIChatCompletionResponse['usage']): Usage | undefined {
  if (!usage) return undefined
  return {
    ...(usage.prompt_tokens !== undefined && { inputTokens: usage.prompt_tokens }),
    ...(usage.completion_tokens !== undefined && { outputTokens: usage.completion_tokens }),
    ...(usage.total_tokens !== undefined && {
      extras: {
        totalTokens: usage.total_tokens,
      },
    }),
  }
}
