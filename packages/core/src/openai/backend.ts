import { inspect } from 'node:util'
import {
  type BackendCapabilities,
  BackendConfigError,
  type BackendContext,
  BackendUpstreamError,
  type InferenceRequest,
  type InferenceResponse,
  type SkelmBackend,
} from '../backend.js'
import { isMultimodal } from '../content.js'
import type { SecretResolver } from '../enforcement/index.js'
import {
  type OpenAIContentPart,
  chatCompletion,
  extractOpenAIMessageContent,
  toOpenAIUsage,
} from './chat-client.js'

export interface OpenAIBackendOptions {
  id?: string
  label?: string
  /** Inline API key. Wins over secretResolver and process.env. */
  apiKey?: string
  baseUrl?: string
  model?: string
  headers?: Readonly<Record<string, string>>
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
        const body = await chatCompletion(baseUrl(opts.baseUrl), {
          apiKey,
          model: req.model ?? opts.model ?? 'gpt-4.1-mini',
          messages: buildMessages(req),
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          responseFormat: req.outputSchema !== undefined ? { type: 'json_object' } : undefined,
          headers: opts.headers,
          signal: ctx.signal,
          backendId,
          fetch: opts.fetch,
        })
        const choice = body.choices?.[0]?.message
        const finishReason = body.choices?.[0]?.finish_reason
        const reasoning = choice?.reasoning_content ?? undefined
        const content = extractOpenAIMessageContent(body, backendId)
        const usage = toOpenAIUsage(body.usage)
        if (req.outputSchema !== undefined) {
          return {
            text: content,
            structured: parseJsonContent(content, backendId),
            ...(reasoning !== undefined && reasoning.length > 0 && { reasoning }),
            ...(finishReason !== undefined && { finishReason }),
            ...(usage !== undefined && { usage }),
          }
        }
        return {
          text: content,
          ...(reasoning !== undefined && reasoning.length > 0 && { reasoning }),
          ...(finishReason !== undefined && { finishReason }),
          ...(usage !== undefined && { usage }),
        }
      } catch (err) {
        if (ctx.signal.aborted) {
          const reason = ctx.signal.reason
          throw reason instanceof Error ? reason : err
        }
        throw err
      }
    },
  }

  return backend
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

function buildMessages(req: InferenceRequest): Array<{
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[]
}> {
  const messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | OpenAIContentPart[]
  }> = []
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
