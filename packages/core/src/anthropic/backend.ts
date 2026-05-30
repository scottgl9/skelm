import { inspect } from 'node:util'
import {
  type AgentRequest,
  type AgentResponse,
  type BackendCapabilities,
  BackendConfigError,
  type BackendContext,
  type InferenceRequest,
  type InferenceResponse,
  type SkelmBackend,
  type Usage,
} from '../backend.js'
import { isMultimodal } from '../content.js'
import type { SecretResolver } from '../enforcement/index.js'
import { formatSkillBlock } from '../skills.js'
import { buildSystemPromptFromRequest } from '../system-prompt.js'

export interface AnthropicBackendOptions {
  id?: string
  label?: string
  /** Inline API key. Wins over secretResolver and process.env. */
  apiKey?: string
  baseUrl?: string
  model?: string
  fetch?: typeof fetch
  /**
   * Optional SecretResolver. When provided and `apiKey` is unset, the
   * backend resolves `ANTHROPIC_API_KEY` through the resolver instead of
   * reading process.env directly. Pass the gateway's resolver here so
   * secret access stays audited.
   */
  secretResolver?: SecretResolver
}

type ApiKeySource = 'explicit' | 'resolver' | 'env'

interface AnthropicBackendDebug {
  apiKey: string | null
  effective: ApiKeySource | null
  getApiKey(): Promise<string>
}

export function createAnthropicBackend(opts: AnthropicBackendOptions = {}): SkelmBackend {
  const envKey = normalizeApiKey(process.env.ANTHROPIC_API_KEY)
  const resolverPromise =
    opts.apiKey === undefined && opts.secretResolver !== undefined
      ? opts.secretResolver.resolve('ANTHROPIC_API_KEY')
      : undefined
  const peekedResolverKey = resolverPromise ? peekResolvedSecret(resolverPromise) : null
  if (opts.apiKey === undefined && resolverPromise === undefined && envKey === undefined) {
    throw new BackendConfigError(
      'Anthropic backend requires an API key (ANTHROPIC_API_KEY)',
      'anthropic',
    )
  }
  const debug: AnthropicBackendDebug = {
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
    skills: true,
    modelSelection: true,
    toolPermissions: 'unsupported',
    vision: true,
  }

  const backend: SkelmBackend & AnthropicBackendDebug = {
    id: opts.id ?? 'anthropic',
    label: opts.label ?? 'Anthropic',
    capabilities,
    get apiKey() {
      return debug.apiKey
    },
    get effective() {
      return debug.effective
    },
    getApiKey: debug.getApiKey,
    async inference(req: InferenceRequest, ctx: BackendContext): Promise<InferenceResponse> {
      const request: AnthropicMessageRequest = {
        messages: toAnthropicMessages(req.messages),
        model: req.model ?? opts.model ?? 'claude-3-5-haiku-latest',
        maxTokens: req.maxTokens ?? 1024,
        outputSchema: req.outputSchema !== undefined,
      }
      if (req.system !== undefined) {
        request.system = req.system
      }
      const body = await requestMessage(request, ctx, opts, await debug.getApiKey())
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
        messages: [{ role: 'user', content: toAnthropicContent(req.prompt) }],
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
      const body = await requestMessage(request, ctx, opts, await debug.getApiKey())
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

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: { type: 'base64'; media_type: string; data: string }
    }

interface AnthropicMessageRequest {
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }>
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
  apiKey: string,
): Promise<AnthropicMessageResponse> {
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
  const raw: unknown = await response.json()
  return assertAnthropicResponse(raw)
}

/**
 * Defensive shape check on the parsed JSON body. Protects against a
 * proxy injecting an error envelope, a misrouted endpoint, or a
 * silent API change yielding a payload that crashes extractText().
 */
function assertAnthropicResponse(body: unknown): AnthropicMessageResponse {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Anthropic response was not a JSON object')
  }
  const b = body as Record<string, unknown>
  if (b.content !== undefined && !Array.isArray(b.content)) {
    throw new Error("Anthropic response 'content' was not an array")
  }
  if (b.usage !== undefined && (typeof b.usage !== 'object' || b.usage === null)) {
    throw new Error("Anthropic response 'usage' was not an object")
  }
  return body as AnthropicMessageResponse
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
  const value = url ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'
  return value.endsWith('/') ? value : `${value}/`
}

function toAnthropicMessages(
  messages: InferenceRequest['messages'],
): Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }> = []
  for (const message of messages) {
    const role: 'user' | 'assistant' = message.role === 'assistant' ? 'assistant' : 'user'
    out.push({ role, content: toAnthropicContent(message.content) })
  }
  return out
}

function toAnthropicContent(
  content: InferenceRequest['messages'][number]['content'] | AgentRequest['prompt'],
): string | AnthropicContentBlock[] {
  if (!isMultimodal(content)) return content
  const blocks: AnthropicContentBlock[] = []
  for (const part of content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text })
    } else {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: part.mimeType, data: part.data },
      })
    }
  }
  return blocks
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
