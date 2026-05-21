/**
 * Pi coding agent SDK backend for skelm.
 *
 * Unlike the RPC backend (which spawns `pi --mode rpc` and cannot intercept
 * individual tool calls), this backend uses the pi SDK directly, allowing
 * skelm to pass a hard tool allowlist that pi enforces natively.
 *
 * System prompt strategy:
 *   By default pi's coding-agent system prompt is kept active. req.system
 *   and skill blocks are appended after it so the agent has full context.
 *   Set options.systemPrompt to replace pi's base prompt entirely.
 *
 * Permission → tool mapping:
 *   allowedExecutables contains 'bash' or 'sh'  → 'bash'
 *   fsRead.size > 0                              → 'read', 'grep', 'find', 'ls'
 *   fsWrite.size > 0                             → 'write', 'edit'
 *   undefined policy                             → no override (pi defaults)
 */

import {
  assertEgressEnforceable as assertEgressEnforceableCore,
  createConcurrencySemaphore,
  extractPromptText,
  loadSkillBodies,
} from '@skelm/core'
import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  ContentPart,
  InferRequest,
  InferResponse,
  ResolvedPolicy,
  SkelmBackend,
} from '@skelm/core'

/**
 * Extract image parts from a prompt for forwarding to pi's `session.prompt`
 * via its `images` option. Pi's ImageContent (`{type:'image', data, mimeType}`)
 * matches skelm's image ContentPart shape one-for-one.
 */
function extractPromptImages(
  prompt: AgentRequest['prompt'] | InferRequest['messages'][number]['content'],
): ReadonlyArray<{ mimeType: string; data: string }> {
  if (typeof prompt === 'string' || prompt === undefined) return []
  return (prompt as readonly ContentPart[])
    .filter((p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image')
    .map((p) => ({ mimeType: p.mimeType, data: p.data }))
}

/**
 * Collect image parts from all `role: 'user'` messages in an `InferRequest`.
 *
 * Intentionally first-turn-only: pi's `session.prompt(text, { images })` is
 * turn-scoped — it sends the supplied images alongside `text` as one user
 * message and starts the agent loop. Multi-turn conversations that resubmit
 * prior-turn imagery would either re-attach the same bytes (wasteful) or
 * silently drop history images here; the simpler behavior is to bundle every
 * image into the single outgoing turn and let pi's session history persist
 * what the model already saw. Assistant/tool messages don't carry images on
 * the skelm side, so filtering on `role: 'user'` is sufficient.
 */
function gatherImagesFromMessages(
  messages: InferRequest['messages'],
): ReadonlyArray<{ mimeType: string; data: string }> {
  const out: Array<{ mimeType: string; data: string }> = []
  for (const m of messages) {
    if (m.role === 'user') {
      for (const img of extractPromptImages(m.content)) out.push(img)
    }
  }
  return out
}
import { PiSdkClient, PiSdkUpstreamError } from './sdk-client.js'
import type { PiSdkBackendOptions } from './types.js'

const assertEgressEnforceable = (policy: ResolvedPolicy | undefined): void =>
  assertEgressEnforceableCore(policy, 'pi-sdk')

export class PiSdkBackendError extends Error {
  override readonly name = 'PiSdkBackendError'
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
  }
}

export class PiSdkBackendAuthenticationError extends PiSdkBackendError {}
export class PiSdkBackendTimeoutError extends PiSdkBackendError {}

/**
 * Create a pi coding agent backend using the pi SDK.
 *
 * This backend builds an explicit tool allowlist from the skelm permission
 * policy so pi itself enforces which tools the agent may use. This provides
 * native enforcement rather than the advisory enforcement of the RPC backend.
 */
/**
 * Resolve provider/model/baseUrl/apiKey from explicit options, falling back to
 * OPENAI_* env vars when present. Returns `undefined` when there's nothing to
 * override — preserving the prior behavior of deferring to
 * `~/.pi/agent/models.json`. Per finding-119.
 *
 * Called once at `createPiSdkBackend()` time — env vars are snapshotted at
 * backend construction. Mutating `OPENAI_BASE_URL` (or its siblings) after
 * the backend exists has no effect on subsequent calls; construct a fresh
 * backend if you need to switch endpoints at runtime. This matches how every
 * other skelm backend reads env vars at construction.
 */
function resolveProviderOverride(options: PiSdkBackendOptions): ProviderOverride | undefined {
  const provider = options.provider ?? process.env.OPENAI_PROVIDER
  const model = options.model ?? process.env.OPENAI_MODEL
  const baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
  // Only override when the caller has actually said something — either an
  // explicit option or a non-empty env var. A bare `provider`/`model` without
  // any endpoint hint defaults to provider='openai' for parity with the rest
  // of skelm's OpenAI-compatible backends.
  if (
    provider === undefined &&
    model === undefined &&
    baseUrl === undefined &&
    apiKey === undefined
  ) {
    return undefined
  }
  if (model === undefined) {
    // No model id at all → cannot register a model entry; let pi pick its
    // built-in default. Pi's default is OpenAI cloud `gpt-5.4`.
    return undefined
  }
  return {
    provider: provider ?? 'openai',
    model,
    ...(baseUrl !== undefined && { baseUrl }),
    ...(apiKey !== undefined && { apiKey }),
    contextWindow: options.contextWindow ?? 131_072,
    maxTokens: options.maxTokens ?? 4096,
  }
}

interface ProviderOverride {
  provider: string
  model: string
  baseUrl?: string
  apiKey?: string
  contextWindow: number
  maxTokens: number
}

export function createPiSdkBackend(options: PiSdkBackendOptions = {}): SkelmBackend {
  const providerOverride = resolveProviderOverride(options)
  const capabilities: BackendCapabilities = {
    prompt: true,
    streaming: true,
    sessionLifecycle: true,
    mcp: false,
    skills: true,
    modelSelection: false,
    toolPermissions: 'native',
    // Pi natively supports multimodal user-message content via its
    // `session.prompt(text, { images })` knob; image parts are forwarded as
    // pi-ai's ImageContent (same shape as skelm's). Whether the configured
    // pi model can actually process images depends on `~/.pi/agent/models.json`
    // (the `input` field on the Model entry); non-vision models surface their
    // own error which the backend propagates. Set `vision: false` to flip on
    // the framework's vision gate for deployments pinned to a text-only pi
    // model.
    vision: options.vision ?? true,
  }

  const { acquire, release } = createConcurrencySemaphore(options.maxConcurrent ?? 4)

  return {
    id: options.id ?? 'pi-sdk',
    label: options.label ?? 'Pi Coding Agent (SDK)',
    capabilities,

    async infer(request: InferRequest, context: BackendContext): Promise<InferResponse> {
      // Fail-closed before acquiring the concurrency slot — see comment on
      // assertEgressEnforceable.
      assertEgressEnforceable(context.permissions)
      await acquire()
      try {
        const cwd = options.cwd
        const promptText = buildInferPrompt(request)
        const client = new PiSdkClient({
          ...(cwd !== undefined && { cwd }),
          // Pure inference: disable all built-in tools
          tools: [],
          noTools: 'all' as const,
          ...(options.noExtensions !== undefined && { noExtensions: options.noExtensions }),
          ...(options.noSkills !== undefined && { noSkills: options.noSkills }),
          ...(options.noContextFiles !== undefined && { noContextFiles: options.noContextFiles }),
          ...(providerOverride !== undefined && { providerOverride }),
          ...(request.system !== undefined && {
            system: request.system,
            replaceSystemPrompt: false,
          }),
        })

        const inferImages = gatherImagesFromMessages(request.messages)
        const result = await client.prompt(
          promptText,
          context.signal,
          options.timeout ?? 300_000,
          context.onPartial,
          inferImages.length > 0 ? inferImages : undefined,
        )

        const response: InferResponse = {
          ...(result.usage !== undefined && {
            usage: {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            },
          }),
        }
        if (request.outputSchema !== undefined) {
          response.structured = parseStructured(result.text)
        } else {
          response.text = result.text
        }
        return response
      } catch (err) {
        throw classifyPiSdkError(err, 'inference')
      } finally {
        release()
      }
    },

    async run(request: AgentRequest, context: BackendContext): Promise<AgentResponse> {
      const policy = context.permissions ?? request.permissions
      // Fail-closed before acquiring the concurrency slot — see comment on
      // assertEgressEnforceable.
      assertEgressEnforceable(policy)
      await acquire()

      try {
        const toolAllowlist = derivePiToolAllowlist(policy)

        const skillBodies = await loadSkillBodies(request, context)
        const systemContent = buildSystemContent(options.systemPrompt, request, skillBodies)

        const cwd = request.cwd ?? options.cwd
        const client = new PiSdkClient({
          ...(cwd !== undefined && { cwd }),
          ...(toolAllowlist !== undefined && { tools: toolAllowlist }),
          ...(policy !== undefined && toolAllowlist?.length === 0 && { noTools: 'all' as const }),
          ...(options.noExtensions !== undefined && { noExtensions: options.noExtensions }),
          ...(options.noSkills !== undefined && { noSkills: options.noSkills }),
          ...(options.noContextFiles !== undefined && { noContextFiles: options.noContextFiles }),
          ...(providerOverride !== undefined && { providerOverride }),
          // System prompt: inject content and indicate whether to replace pi's base
          ...(systemContent !== undefined && {
            system: systemContent,
            replaceSystemPrompt: options.systemPrompt !== undefined,
          }),
        })

        const agentImages = extractPromptImages(request.prompt)
        const result = await client.prompt(
          extractPromptText(request.prompt),
          context.signal,
          options.timeout ?? 300_000,
          context.onPartial,
          agentImages.length > 0 ? agentImages : undefined,
        )

        return {
          text: result.text,
          stopReason: result.stopReason,
          ...(result.usage !== undefined && {
            usage: {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            },
          }),
        }
      } catch (err) {
        throw classifyPiSdkError(err, 'agent execution')
      } finally {
        release()
      }
    },
  }
}

function classifyPiSdkError(err: unknown, action: 'inference' | 'agent execution'): Error {
  if (err instanceof PiSdkUpstreamError) {
    // Already carries provider/model + upstream errorMessage; surface it as
    // a backend-level error without obscuring the diagnostic.
    return new PiSdkBackendError(`pi SDK ${action} failed: ${err.message}`, err)
  }
  if (err instanceof Error) {
    if (err.message.includes('ENOENT') || err.message.includes('not installed')) {
      return new PiSdkBackendAuthenticationError(
        'pi SDK not available. Install it: npm install @mariozechner/pi-coding-agent',
        err,
      )
    }
    if (err.message.includes('timed out')) {
      return new PiSdkBackendTimeoutError(err.message, err)
    }
  }
  return new PiSdkBackendError(`pi SDK ${action} failed: ${(err as Error).message}`, err)
}

/**
 * Derive a pi tool allowlist from a skelm permission policy.
 *
 * Returns `undefined` when no policy is set (pi uses its defaults).
 * Returns a string[] (possibly empty) when a policy is present.
 *
 * networkEgress: 'deny' suppresses the bash tool entirely — pi has no native
 * fetch tool, so the only way an agent can reach the network is via
 * `curl`/`wget`/etc. spawned through bash. Dropping bash from the allowlist
 * is a coarse but reliable enforcement of network-deny.
 */
export function derivePiToolAllowlist(policy: ResolvedPolicy | undefined): string[] | undefined {
  if (policy === undefined) return undefined

  const networkDenied = policy.networkEgress === 'deny'

  const allowed: string[] = []

  const execs = policy.allowedExecutables
  if (!networkDenied && (execs.has('bash') || execs.has('sh'))) {
    allowed.push('bash')
  }

  const fsRead = policy.fsRead
  if (fsRead instanceof Set ? fsRead.size > 0 : Array.isArray(fsRead) && fsRead.length > 0) {
    allowed.push('read', 'grep', 'find', 'ls')
  }

  const fsWrite = policy.fsWrite
  if (fsWrite instanceof Set ? fsWrite.size > 0 : Array.isArray(fsWrite) && fsWrite.length > 0) {
    if (!allowed.includes('read')) allowed.push('read', 'grep', 'find', 'ls')
    allowed.push('write', 'edit')
  }

  return allowed
}

/**
 * Assemble the system content to inject into pi's system prompt.
 *
 * When systemBase is set it replaces pi's prompt; req.system and skills are
 * always appended so the agent has the step's context regardless of mode.
 */
function buildSystemContent(
  systemBase: string | undefined,
  req: AgentRequest,
  skillBodies: string[],
): string | undefined {
  const parts: string[] = []
  if (systemBase !== undefined) parts.push(systemBase)
  if (req.agentDef?.soul !== undefined) parts.push(req.agentDef.soul)
  if (req.agentDef !== undefined) parts.push(req.agentDef.instructions)
  if (req.system) parts.push(req.system)
  for (const body of skillBodies) parts.push(body)
  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined
}

/**
 * Concatenate InferRequest messages into a single prompt string.
 * Pi runs as a chat agent that takes one user prompt — for multi-turn
 * histories we serialize the conversation into a labeled transcript.
 */
function buildInferPrompt(req: InferRequest): string {
  // Pi does not support image content; collapse any multimodal messages to
  // their text parts. Callers needing vision should route to a vision-capable
  // backend (anthropic / openai).
  const asText = (content: (typeof req.messages)[number]['content']): string =>
    typeof content === 'string'
      ? content
      : content
          .filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join('')
  if (req.messages.length === 1 && req.messages[0]?.role === 'user') {
    return asText(req.messages[0].content)
  }
  return req.messages
    .map(
      (m) =>
        `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${asText(m.content)}`,
    )
    .join('\n\n')
}

/**
 * Extract a JSON value from the model's text output. Tolerates ```json
 * fenced blocks and surrounding prose. The runner validates the result
 * against the step's output schema, so we only need to parse here.
 */
function parseStructured(text: string): unknown {
  const candidate = extractJson(text)
  if (candidate === null) {
    throw new PiSdkBackendError(
      `pi inference returned no parseable JSON. Output (first 200 chars): ${text.slice(0, 200)}`,
    )
  }
  try {
    return JSON.parse(candidate)
  } catch (err) {
    throw new PiSdkBackendError(
      `pi inference output is not valid JSON: ${(err as Error).message}. Raw: ${text.slice(0, 200)}`,
      err,
    )
  }
}

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) return fenced[1].trim()
  const start = text.search(/[{[]/)
  if (start === -1) return null
  // Greedy: take from first opener through last matching closer.
  const opener = text[start]
  const closer = opener === '{' ? '}' : ']'
  const end = text.lastIndexOf(closer)
  if (end <= start) return null
  return text.slice(start, end + 1)
}
