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

function buildChatRequestBody(
  opts: OpenAIChatCompletionOptions,
  stream: boolean,
): Record<string, unknown> {
  return {
    model: opts.model,
    messages: opts.messages,
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    ...(opts.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
    ...(opts.tools !== undefined && opts.tools.length > 0 && { tools: opts.tools }),
    ...(opts.responseFormat !== undefined && { response_format: opts.responseFormat }),
    stream,
    ...(stream && { stream_options: { include_usage: true } }),
  }
}

function classifyChatTransportError(
  err: unknown,
  opts: OpenAIChatCompletionOptions,
  timeoutSignal: AbortSignal | undefined,
  backendId: string,
): Error {
  if (isKnownBackendError(err)) return err as Error
  if (opts.signal?.aborted) {
    const reason = opts.signal.reason
    return reason instanceof Error
      ? reason
      : new BackendTimeoutError('OpenAI request aborted', backendId)
  }
  if (timeoutSignal?.aborted) {
    return new BackendTimeoutError('OpenAI request timed out', backendId, { cause: err })
  }
  return new BackendNetworkError(
    `OpenAI network request failed: ${err instanceof Error ? err.message : String(err)}`,
    backendId,
    { cause: err },
  )
}

async function postChatRequest(
  baseUrl: string,
  opts: OpenAIChatCompletionOptions,
  body: Record<string, unknown>,
  backendId: string,
  timeoutSignal: AbortSignal | undefined,
): Promise<Response> {
  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  }
  if (opts.apiKey) {
    requestHeaders.Authorization = `Bearer ${opts.apiKey}`
  }
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
    throw classifyChatTransportError(err, opts, timeoutSignal, backendId)
  }

  if (!res.ok) {
    throw await classifyOpenAIHttpError(res, backendId)
  }
  return res
}

export async function chatCompletion(
  baseUrl: string,
  opts: OpenAIChatCompletionOptions,
): Promise<OpenAIChatResponse> {
  const backendId = opts.backendId ?? 'openai'
  const timeoutSignal =
    opts.timeoutMs !== undefined ? AbortSignal.timeout(opts.timeoutMs) : undefined
  const res = await postChatRequest(
    baseUrl,
    opts,
    buildChatRequestBody(opts, false),
    backendId,
    timeoutSignal,
  )
  const rawBody: unknown = await res.json()
  return assertOpenAIResponse(rawBody, backendId)
}

/** One streamed chunk in the OpenAI `stream: true` wire format. */
interface OpenAIStreamChunk {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    delta?: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: OpenAIChatResponse['usage'] | null
}

export interface OpenAIChatStreamOptions extends OpenAIChatCompletionOptions {
  /**
   * Called once per assistant-content chunk as it arrives. Each call carries
   * ONE new delta (not the cumulative text); the concatenation of all deltas
   * equals the assembled `message.content` of the returned response.
   */
  onDelta: (delta: string) => void
}

/**
 * Streaming variant of `chatCompletion` (`stream: true`, Server-Sent Events).
 * Content deltas are forwarded to `onDelta` as they arrive; tool-call and
 * reasoning deltas are assembled silently. Resolves to the same
 * `OpenAIChatResponse` shape as the non-streaming call so callers can share
 * their response handling.
 *
 * If the upstream ignores `stream: true` and answers with a plain JSON body,
 * the response is parsed normally and its full text is emitted as a single
 * delta — callers do not need to special-case non-streaming servers that
 * accept the flag.
 */
export async function chatCompletionStream(
  baseUrl: string,
  opts: OpenAIChatStreamOptions,
): Promise<OpenAIChatResponse> {
  const backendId = opts.backendId ?? 'openai'
  const timeoutSignal =
    opts.timeoutMs !== undefined ? AbortSignal.timeout(opts.timeoutMs) : undefined
  const res = await postChatRequest(
    baseUrl,
    opts,
    buildChatRequestBody(opts, true),
    backendId,
    timeoutSignal,
  )

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    // Upstream ignored `stream: true` and replied with a regular completion.
    const rawBody: unknown = await res.json()
    const response = assertOpenAIResponse(rawBody, backendId)
    const text = response.choices?.[0]?.message?.content
    if (typeof text === 'string' && text.length > 0) opts.onDelta(text)
    return response
  }

  if (res.body === null) {
    throw new BackendUpstreamError('OpenAI stream response had no body', backendId)
  }

  let id: string | undefined
  let model: string | undefined
  let content = ''
  let reasoning = ''
  let finishReason: string | undefined
  let usage: OpenAIChatResponse['usage']
  let sawChunk = false
  const toolCalls = new Map<
    number,
    { id: string; type: string; function: { name: string; arguments: string } }
  >()

  const handleData = (data: string): void => {
    if (data === '[DONE]') return
    let chunk: OpenAIStreamChunk
    try {
      chunk = JSON.parse(data) as OpenAIStreamChunk
    } catch {
      // Tolerate malformed keep-alive / vendor extension lines.
      return
    }
    sawChunk = true
    if (chunk.id !== undefined) id = chunk.id
    if (chunk.model !== undefined) model = chunk.model
    if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage
    const choice = chunk.choices?.[0]
    if (choice === undefined) return
    const delta = choice.delta
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      content += delta.content
      opts.onDelta(delta.content)
    }
    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      reasoning += delta.reasoning_content
    }
    for (const tc of delta?.tool_calls ?? []) {
      const index = tc.index ?? 0
      let entry = toolCalls.get(index)
      if (entry === undefined) {
        entry = { id: '', type: 'function', function: { name: '', arguments: '' } }
        toolCalls.set(index, entry)
      }
      if (tc.id !== undefined && tc.id.length > 0) entry.id = tc.id
      if (tc.type !== undefined && tc.type.length > 0) entry.type = tc.type
      // Name arrives whole (some servers resend it per chunk) — assign, don't
      // append. Arguments stream as JSON fragments — append.
      if (tc.function?.name !== undefined && tc.function.name.length > 0) {
        entry.function.name = tc.function.name
      }
      if (tc.function?.arguments !== undefined) {
        entry.function.arguments += tc.function.arguments
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      finishReason = choice.finish_reason
    }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) handleData(line.slice(5).trim())
        newline = buffer.indexOf('\n')
      }
    }
    const tail = buffer.replace(/\r$/, '')
    if (tail.startsWith('data:')) handleData(tail.slice(5).trim())
  } catch (err) {
    throw classifyChatTransportError(err, opts, timeoutSignal, backendId)
  } finally {
    reader.releaseLock()
  }

  if (!sawChunk) {
    throw new BackendUpstreamError('OpenAI stream ended without any data events', backendId)
  }

  return {
    ...(id !== undefined && { id }),
    object: 'chat.completion',
    ...(model !== undefined && { model }),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(reasoning.length > 0 && { reasoning_content: reasoning }),
          ...(toolCalls.size > 0 && {
            tool_calls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, tc]) => tc),
          }),
        },
        ...(finishReason !== undefined && { finish_reason: finishReason }),
      },
    ],
    ...(usage !== undefined && { usage }),
  }
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
