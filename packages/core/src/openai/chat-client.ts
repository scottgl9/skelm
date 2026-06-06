import {
  BackendAuthenticationError,
  BackendNetworkError,
  BackendRateLimitError,
  BackendTimeoutError,
  BackendUpstreamError,
  type Usage,
} from '../backend.js'

export interface OpenAIErrorResponse {
  error?: {
    message?: string
    type?: string
    code?: string
  }
  message?: string
}

export interface OpenAIChatResponse {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: Array<{
    index?: number
    message?: {
      role?: string
      content?: string | Array<{ type?: string; text?: string }> | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        id: string
        type: string
        function: {
          name: string
          arguments: string
        }
      }>
    }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | readonly OpenAIContentPart[]
  name?: string
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface OpenAIChatCompletionOptions {
  apiKey?: string | undefined
  model: string
  messages: readonly OpenAIMessage[]
  temperature?: number | undefined
  maxTokens?: number | undefined
  responseFormat?: { type: 'json_object' | 'text' } | undefined
  tools?: readonly OpenAITool[] | undefined
  headers?: Readonly<Record<string, string>> | undefined
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
  backendId?: string | undefined
  fetch?: typeof fetch | undefined
}

export async function chatCompletion(
  baseUrl: string,
  opts: OpenAIChatCompletionOptions,
): Promise<OpenAIChatResponse> {
  const backendId = opts.backendId ?? 'openai'
  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  }
  if (opts.apiKey) {
    requestHeaders.Authorization = `Bearer ${opts.apiKey}`
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    ...(opts.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
    ...(opts.tools !== undefined && opts.tools.length > 0 && { tools: opts.tools }),
    ...(opts.responseFormat !== undefined && { response_format: opts.responseFormat }),
    stream: false,
  }

  const timeoutSignal =
    opts.timeoutMs !== undefined ? AbortSignal.timeout(opts.timeoutMs) : undefined
  const signal =
    opts.signal !== undefined && timeoutSignal !== undefined
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : (opts.signal ?? timeoutSignal)

  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      ...(signal !== undefined && { signal }),
    })
  } catch (err) {
    if (isKnownBackendError(err)) throw err
    if (opts.signal?.aborted) {
      const reason = opts.signal.reason
      throw reason instanceof Error
        ? reason
        : new BackendTimeoutError('OpenAI request aborted', backendId)
    }
    if (timeoutSignal?.aborted) {
      throw new BackendTimeoutError('OpenAI request timed out', backendId, { cause: err })
    }
    throw new BackendNetworkError(
      `OpenAI network request failed: ${err instanceof Error ? err.message : String(err)}`,
      backendId,
      { cause: err },
    )
  }

  if (!res.ok) {
    throw await classifyOpenAIHttpError(res, backendId)
  }

  const rawBody: unknown = await res.json()
  return assertOpenAIResponse(rawBody, backendId)
}

export function chatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/chat/completions')) return url.toString()
  url.pathname = path.endsWith('/v1') ? `${path}/chat/completions` : `${path}/v1/chat/completions`
  url.search = ''
  return url.toString()
}

export function extractOpenAIMessageContent(body: OpenAIChatResponse, backendId: string): string {
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

export function toOpenAIUsage(usage: OpenAIChatResponse['usage']): Usage | undefined {
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

function assertOpenAIResponse(body: unknown, backendId: string): OpenAIChatResponse {
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
  return body as OpenAIChatResponse
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

async function readErrorBody(response: Response): Promise<{ body: unknown; message?: string }> {
  try {
    const body = (await response.json()) as OpenAIErrorResponse
    const message =
      typeof body.error?.message === 'string'
        ? body.error.message
        : typeof body.message === 'string'
          ? body.message
          : undefined
    return { body, ...(message !== undefined && { message }) }
  } catch {
    return { body: undefined }
  }
}

function isKnownBackendError(err: unknown): boolean {
  if (
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
