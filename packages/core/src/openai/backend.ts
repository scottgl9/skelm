import type {
  BackendCapabilities,
  BackendContext,
  InferRequest,
  InferResponse,
  SkelmBackend,
  Usage,
} from '../backend.js'
import { isMultimodal } from '../content.js'

export interface OpenAIBackendOptions {
  id?: string
  label?: string
  apiKey?: string
  baseUrl?: string
  model?: string
  fetch?: typeof fetch
}

export function createOpenAIBackend(opts: OpenAIBackendOptions = {}): SkelmBackend {
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

  const backend: SkelmBackend = {
    id: opts.id ?? 'openai',
    label: opts.label ?? 'OpenAI',
    capabilities,
    async infer(req: InferRequest, ctx: BackendContext): Promise<InferResponse> {
      const apiKey = resolveApiKey(opts.apiKey)
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
      const body = (await response.json()) as OpenAIChatCompletionResponse
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

function resolveApiKey(explicit?: string): string {
  const apiKey = explicit ?? process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OpenAI backend requires an API key (OPENAI_API_KEY)')
  }
  return apiKey
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
