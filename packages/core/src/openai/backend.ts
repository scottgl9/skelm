import { inspect } from 'node:util'
import {
  BackendAuthenticationError,
  type BackendCapabilities,
  BackendConfigError,
  type BackendContext,
  BackendNetworkError,
  BackendRateLimitError,
  BackendTimeoutError,
  BackendUpstreamError,
  type InferenceRequest,
  type InferenceResponse,
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
  // The missing-key error is deferred to first use (resolveApiKey) rather than
  // thrown here: constructing this backend must not crash gateway startup just
  // because it sits in the default config and OPENAI_API_KEY is unset. A
  // workflow that actually invokes the openai backend fails at the step with a
  // clear BackendConfigError; one that never uses it runs unaffected.
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
    async inference(req: InferenceRequest, ctx: BackendContext): Promise<InferenceResponse> {
      const backendId = opts.id ?? 'openai'
      try {
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
          throw await classifyOpenAIHttpError(response, backendId)
        }
        const rawBody: unknown = await response.json()
        const body = assertOpenAIResponse(rawBody, backendId)
        const content = extractMessageContent(body, backendId)
        const usage = toUsage(body.usage)
        if (req.outputSchema !== undefined) {
          return {
            text: content,
            structured: parseJsonContent(content, backendId),
            ...(usage !== undefined && { usage }),
          }
        }
        return {
          text: content,
          ...(usage !== undefined && { usage }),
        }
      } catch (err) {
        throw classifyOpenAIError(err, ctx, backendId)
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
function assertOpenAIResponse(body: unknown, backendId: string): OpenAIChatCompletionResponse {
  if (typeof body !== 'object' || body === null) {
    throw new BackendUpstreamError('OpenAI response was not a JSON object', backendId, undefined, {
      cause: body,
    })
  }
  const b = body as Record<string, unknown>
  if (b.choices !== undefined && !Array.isArray(b.choices)) {
    throw new BackendUpstreamError(
      "OpenAI response 'choices' was not an array",
      backendId,
      undefined,
      {
        cause: body,
      },
    )
  }
  if (b.usage !== undefined && (typeof b.usage !== 'object' || b.usage === null)) {
    throw new BackendUpstreamError(
      "OpenAI response 'usage' was not an object",
      backendId,
      undefined,
      {
        cause: body,
      },
    )
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
  if (envKey !== undefined) return envKey
  // Deferred from construction: a missing key only fails when the backend is
  // actually invoked, not at gateway startup.
  throw new BackendConfigError('OpenAI backend requires an API key (OPENAI_API_KEY)', 'openai')
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
  const value =
    normalizeApiKey(url) ??
    normalizeApiKey(process.env.OPENAI_BASE_URL) ??
    'https://api.openai.com/v1'
  return value.endsWith('/') ? value : `${value}/`
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

function buildMessages(
  req: InferenceRequest,
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
  content: InferenceRequest['messages'][number]['content'],
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

function extractMessageContent(body: OpenAIChatCompletionResponse, backendId: string): string {
  const content = body.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
  }
  throw new BackendUpstreamError(
    'OpenAI response did not include message content',
    backendId,
    undefined,
    {
      cause: body,
    },
  )
}

function parseJsonContent(content: string, backendId: string): unknown {
  try {
    return JSON.parse(content)
  } catch (err) {
    throw new BackendUpstreamError(
      `OpenAI backend returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      backendId,
      undefined,
      { cause: err },
    )
  }
}

async function classifyOpenAIHttpError(response: Response, backendId: string): Promise<Error> {
  const upstream = await readErrorBody(response)
  const message = `OpenAI request failed (${response.status} ${response.statusText})${upstream.message !== undefined ? `: ${upstream.message}` : ''}`
  if (response.status === 401 || response.status === 403) {
    return new BackendAuthenticationError(message, backendId, { cause: upstream.body })
  }
  if (response.status === 429) {
    return new BackendRateLimitError(message, backendId, { cause: upstream.body })
  }
  if (response.status === 408 || response.status === 504) {
    return new BackendTimeoutError(message, backendId, { cause: upstream.body })
  }
  return new BackendUpstreamError(message, backendId, response.status, { cause: upstream.body })
}

function classifyOpenAIError(err: unknown, ctx: BackendContext, backendId: string): unknown {
  if (isKnownBackendError(err)) {
    return err
  }
  if (ctx.signal.aborted) {
    const reason = ctx.signal.reason
    return reason instanceof Error
      ? reason
      : new BackendTimeoutError('OpenAI request aborted', backendId)
  }
  return new BackendNetworkError(
    `OpenAI network request failed: ${err instanceof Error ? err.message : String(err)}`,
    backendId,
    { cause: err },
  )
}

function isKnownBackendError(err: unknown): boolean {
  if (
    err instanceof BackendConfigError ||
    err instanceof BackendUpstreamError ||
    err instanceof BackendAuthenticationError ||
    err instanceof BackendRateLimitError ||
    err instanceof BackendTimeoutError ||
    err instanceof BackendNetworkError
  ) {
    return true
  }
  return err instanceof Error && /^Backend[A-Za-z]+Error$/.test(err.name)
}

async function readErrorBody(response: Response): Promise<{ body: unknown; message?: string }> {
  try {
    const body = await response.json()
    const message =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { error?: { message?: unknown } }).error?.message === 'string'
        ? (body as { error: { message: string } }).error.message
        : typeof body === 'object' &&
            body !== null &&
            typeof (body as { message?: unknown }).message === 'string'
          ? (body as { message: string }).message
          : undefined
    return { body, ...(message !== undefined && { message }) }
  } catch {
    return { body: undefined }
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
