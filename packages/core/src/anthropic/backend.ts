import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  InferRequest,
  InferResponse,
  SkelmBackend,
  Usage,
} from '../backend.js'
import { formatSkillBlock } from '../skills.js'
import { buildSystemPromptFromRequest } from '../system-prompt.js'

export interface AnthropicBackendOptions {
  id?: string
  label?: string
  apiKey?: string
  baseUrl?: string
  model?: string
  fetch?: typeof fetch
}

export function createAnthropicBackend(opts: AnthropicBackendOptions = {}): SkelmBackend {
  const capabilities: BackendCapabilities = {
    prompt: true,
    streaming: false,
    sessionLifecycle: false,
    mcp: false,
    skills: true,
    modelSelection: true,
    toolPermissions: 'unsupported',
  }

  const backend: SkelmBackend = {
    id: opts.id ?? 'anthropic',
    label: opts.label ?? 'Anthropic',
    capabilities,
    async infer(req: InferRequest, ctx: BackendContext): Promise<InferResponse> {
      const request: AnthropicMessageRequest = {
        messages: toAnthropicMessages(req.messages),
        model: req.model ?? opts.model ?? 'claude-3-5-haiku-latest',
        maxTokens: req.maxTokens ?? 1024,
        outputSchema: req.outputSchema !== undefined,
      }
      if (req.system !== undefined) {
        request.system = req.system
      }
      const body = await requestMessage(request, ctx, opts)
      const text = extractText(body)
      const usage = toUsage(body.usage)
      if (req.outputSchema !== undefined) {
        return {
          text,
          structured: parseJsonContent(text),
          ...(usage !== undefined && { usage }),
        }
      }
      return {
        text,
        ...(usage !== undefined && { usage }),
      }
    },
    async run(req: AgentRequest, ctx: BackendContext): Promise<AgentResponse> {
      const request: AnthropicMessageRequest = {
        messages: [{ role: 'user', content: req.prompt }],
        model: opts.model ?? 'claude-3-5-haiku-latest',
        maxTokens: 1024,
        outputSchema: req.outputSchema !== undefined,
      }
      const skillBlocks: string[] = []
      const skillSummaries: Array<{ name: string; description: string; location?: string }> = []
      if (req.skills !== undefined && req.skills.length > 0 && ctx.loadSkill !== undefined) {
        for (const skillId of req.skills) {
          const skill = await ctx.loadSkill(skillId)
          if (skill !== null) {
            skillBlocks.push(formatSkillBlock(skill))
            skillSummaries.push({
              name: skill.id,
              description: skill.description ?? '',
              location: skill.source,
            })
          }
        }
      }
      // Anthropic's run() is single-shot and doesn't dispatch tools through
      // skelm's permission layer — pass an empty tool list so the builder
      // skips the tool-use / available-tools sections.
      const systemPrompt = buildSystemPromptFromRequest(req, {
        cwd: process.cwd(),
        platform: process.platform,
        date: new Date().toISOString().slice(0, 10),
        model: request.model,
        tools: [],
        ...(skillSummaries.length > 0 && { skills: skillSummaries }),
      })
      const parts: string[] = []
      if (systemPrompt.length > 0) parts.push(systemPrompt)
      // Append full skill bodies after the inventory so the model has the
      // actual instructions, not just the summary.
      for (const block of skillBlocks) parts.push(block)
      if (parts.length > 0) {
        request.system = parts.join('\n\n---\n\n')
      }
      const body = await requestMessage(request, ctx, opts)
      const text = extractText(body)
      const usage = toUsage(body.usage)
      if (req.outputSchema !== undefined) {
        return {
          text,
          structured: parseJsonContent(text),
          stopReason: body.stop_reason ?? 'end_turn',
          ...(usage !== undefined && { usage }),
        }
      }
      return {
        text,
        stopReason: body.stop_reason ?? 'end_turn',
        ...(usage !== undefined && { usage }),
      }
    },
  }

  return backend
}

interface AnthropicMessageRequest {
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  model: string
  maxTokens: number
  outputSchema: boolean
}

interface AnthropicMessageResponse {
  content?: Array<{ type?: string; text?: string }>
  stop_reason?: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

async function requestMessage(
  req: AnthropicMessageRequest,
  ctx: BackendContext,
  opts: AnthropicBackendOptions,
): Promise<AnthropicMessageResponse> {
  const apiKey = resolveApiKey(opts.apiKey)
  const response = await (opts.fetch ?? fetch)(new URL('/v1/messages', baseUrl(opts.baseUrl)), {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens,
      ...(req.system !== undefined && {
        system: req.outputSchema
          ? `${req.system}\n\nReturn only valid JSON matching the requested output shape.`
          : req.system,
      }),
      ...(req.system === undefined &&
        req.outputSchema && {
          system: 'Return only valid JSON matching the requested output shape.',
        }),
      messages: req.messages,
    }),
    signal: ctx.signal,
  })
  if (!response.ok) {
    throw new Error(`Anthropic request failed (${response.status} ${response.statusText})`)
  }
  return (await response.json()) as AnthropicMessageResponse
}

function resolveApiKey(explicit?: string): string {
  const apiKey = explicit ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('Anthropic backend requires an API key (ANTHROPIC_API_KEY)')
  }
  return apiKey
}

function baseUrl(url?: string): string {
  const value = url ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'
  return value.endsWith('/') ? value : `${value}/`
}

function toAnthropicMessages(
  messages: InferRequest['messages'],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      out.push({ role: 'assistant', content: message.content })
    } else {
      out.push({ role: 'user', content: message.content })
    }
  }
  return out
}

function extractText(body: AnthropicMessageResponse): string {
  const text = body.content
    ?.filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
  if (!text) {
    throw new Error('Anthropic response did not include text content')
  }
  return text
}

function parseJsonContent(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch (err) {
    throw new Error(`Anthropic backend returned invalid JSON: ${(err as Error).message}`)
  }
}

function toUsage(usage: AnthropicMessageResponse['usage']): Usage | undefined {
  if (!usage) return undefined
  return {
    ...(usage.input_tokens !== undefined && { inputTokens: usage.input_tokens }),
    ...(usage.output_tokens !== undefined && { outputTokens: usage.output_tokens }),
  }
}
