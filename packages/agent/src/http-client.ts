/**
 * Minimal OpenAI chat-completions HTTP client used by the agent backend.
 * Separated from the agent loop so the loop can be read without wading
 * through wire-format types.
 */

import { BackendUpstreamError } from '@skelm/core'

export interface OpenAIErrorResponse {
  error?: {
    message?: string
    type?: string
    code?: string
  }
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
      content?: string | null
      /**
       * Reasoning/"thinking" text emitted by models that surface their
       * internal monologue separately from the final assistant `content`
       * (Qwen 3.x, DeepSeek-R1, o1-style). The OpenAI Chat Completions
       * spec doesn't define this field, but most local/sglang/vLLM
       * deployments and providers like OpenRouter pass it through here.
       */
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

/**
 * OpenAI chat-completions content parts. The user role accepts an array of
 * parts (text and image_url) for multimodal prompts; other roles use a plain
 * string. This mirrors OpenAI's documented content schema:
 * https://platform.openai.com/docs/api-reference/chat/create
 */
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

export async function chatCompletion(
  baseUrl: string,
  opts: {
    apiKey: string | undefined
    model: string
    messages: readonly OpenAIMessage[]
    temperature: number | undefined
    maxTokens: number | undefined
    responseFormat: { type: 'json_object' | 'text' } | undefined
    tools: readonly OpenAITool[] | undefined
    signal: AbortSignal | undefined
    timeoutMs: number
  },
): Promise<OpenAIChatResponse> {
  const url = new URL('/v1/chat/completions', baseUrl)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`
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

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs)
  const combinedSignal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: combinedSignal,
  })

  if (!res.ok) {
    let errMsg = res.statusText
    try {
      const errBody = (await res.json()) as OpenAIErrorResponse
      if (errBody.error?.message) {
        errMsg = errBody.error.message
      }
    } catch {
      // ignore
    }
    throw new BackendUpstreamError(
      `OpenAI-compatible request failed (${res.status}): ${errMsg}`,
      undefined,
      res.status,
    )
  }

  return (await res.json()) as OpenAIChatResponse
}
