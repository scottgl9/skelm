/**
 * @skelm/agent — First-party skelm agent backend
 *
 * A SkelmBackend that drives a multi-turn agent loop using an
 * OpenAI-compatible chat completions endpoint, with native permission
 * enforcement for tools, filesystem, and network access.
 *
 * No dependency on ACP, Pi, Opencode, or any external agent runtime.
 *
 * Capabilities:
 * - `prompt: true`  — powers `llm()` steps via single-shot inference
 * - `run()`: true   — powers `agent()` steps with multi-turn tool-use loop
 * - `toolPermissions: 'native'` — we enforce every permission before
 *   dispatching tool calls; no external sandbox required.
 */

import { LLMTruncatedError, type McpHost, createMcpHost } from '@skelm/core'
import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  ContentPart,
  InferRequest,
  InferResponse,
  SkelmBackend,
  Usage,
} from '@skelm/core/backend'
import type { ResolvedPolicy } from '@skelm/core/permissions'
import { TrustEnforcer } from '@skelm/core/permissions'

import { type OpenAIContentPart, type OpenAIMessage, chatCompletion } from './http-client.js'
import type { ModelRegistry } from './models/registry.js'
import type { ResolvedModel } from './models/types.js'
import { buildSystemPromptFromRequest, toUsage } from './prompt.js'
import { BUILTIN_TOOLS, type ToolExecutionContext, type ToolResult, toOpenAITool } from './tools.js'

export interface SkelmAgentOptions {
  /** Backend id. Defaults to 'agent' when only one is registered. */
  id?: string
  /** Human-readable label for diagnostics. */
  label?: string
  /**
   * Base URL of an OpenAI-compatible chat completions endpoint. Required
   * unless `registry` is set; with a registry, the provider entry supplies
   * the URL per call.
   */
  baseUrl?: string
  /** API key (required for most providers). */
  apiKey?: string
  /** Default model id used when the step doesn't specify one. */
  model?: string
  /** Timeout in milliseconds for LLM HTTP requests (default 300 000 = 5 min). */
  timeoutMs?: number
  /**
   * Advertise `capabilities.vision`. Defaults to `true`: the backend forwards
   * image content to the upstream OpenAI-compatible endpoint and lets it
   * decide whether the configured model can process it. Models that can't
   * will surface their own 4xx/5xx, which `@skelm/agent` propagates as a
   * thrown error — there is no silent strip. Set to `false` if you want the
   * framework's vision gate to reject image prompts at step start instead
   * (useful when you know the configured model is text-only and want a
   * deterministic error before any HTTP egress).
   */
  vision?: boolean
  /**
   * Default cap on output tokens per chat completion. Sent as `max_tokens`
   * on the OpenAI Chat Completions request body. Per-call `req.maxTokens`
   * (on `llm()` steps) overrides this default; the agent loop (`run()`)
   * uses it on every turn since `req.maxTokens` isn't plumbed there.
   *
   * Omit to let the upstream pick its own default (typically the model's
   * full output context). For local llama.cpp / sglang servers this is
   * usually unbounded by default and can produce very long replies; set
   * an explicit ceiling for predictable latency.
   */
  maxTokens?: number
  /**
   * Optional multi-provider model registry. When set, per-call routing
   * uses `req.model` (or `defaultModel`) to look up a `ResolvedModel` from
   * the registry; the entry carries its own `baseUrl`/`apiKey`/cost shape
   * and overrides the top-level `baseUrl`/`apiKey`/`model`.
   *
   * Backwards compatible — leave unset to keep the single-endpoint config.
   */
  registry?: ModelRegistry
  /**
   * Required when `registry` is set. Identifies which entry to use when
   * the per-call request omits an explicit model.
   */
  defaultModel?: { provider: string; id: string }
}

function resolveCallModel(
  opts: SkelmAgentOptions,
  requestedModelId: string | undefined,
):
  | { kind: 'registry'; resolved: ResolvedModel }
  | { kind: 'single'; baseUrl: string; apiKey: string | undefined; modelId: string } {
  if (opts.registry !== undefined) {
    const reg = opts.registry
    const fallback = opts.defaultModel
    if (requestedModelId !== undefined) {
      const providers = reg.listProviders()
      for (const provider of providers) {
        const hit = reg.find(provider, requestedModelId)
        if (hit !== undefined) return { kind: 'registry', resolved: hit }
      }
      if (fallback === undefined) {
        throw new Error(
          `model '${requestedModelId}' not found in registry and no defaultModel configured`,
        )
      }
    }
    if (fallback === undefined) {
      throw new Error('SkelmAgentOptions.registry set without defaultModel')
    }
    const hit = reg.find(fallback.provider, fallback.id)
    if (hit === undefined) {
      throw new Error(`defaultModel ${fallback.provider}/${fallback.id} not found in registry`)
    }
    return { kind: 'registry', resolved: hit }
  }
  if (opts.baseUrl === undefined) {
    throw new Error('SkelmAgentOptions requires either `baseUrl` or `registry` + `defaultModel`')
  }
  return {
    kind: 'single',
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    modelId: requestedModelId ?? opts.model ?? 'qwen36',
  }
}

function createDefaultPolicy(cwd: string, agentDefRoot: string): ResolvedPolicy {
  const roots = new Set<string>([cwd, agentDefRoot])
  return Object.freeze({
    allowedTools: Object.freeze({ exact: new Set<string>(), prefixes: [], star: true }),
    deniedTools: Object.freeze({ exact: new Set<string>(), prefixes: [], star: false }),
    allowedExecutables: new Set<string>(),
    allowedMcpServers: new Set<string>(),
    allowedSkills: new Set<string>(),
    allowedSecrets: new Set<string>(),
    networkEgress: 'deny',
    fsRead: roots,
    fsWrite: roots,
    approval: null,
  })
}

function isObjectSchema(s: unknown): s is Record<string, unknown> {
  return typeof s === 'object' && s !== null && !Array.isArray(s)
}

/**
 * Map a skelm `PromptMessage.content` (string or `ContentPart[]`) to the
 * OpenAI chat-completions content shape. String content stays as a string;
 * multimodal arrays become `[{type:'text'}, {type:'image_url'}, ...]`. Image
 * parts are encoded as base64 data URLs since that's the universally
 * supported form across OpenAI cloud, llama.cpp, sglang, vLLM, and ollama.
 */
function toOpenAIChatContent(
  content: string | readonly ContentPart[] | undefined,
): string | readonly OpenAIContentPart[] {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  const parts: OpenAIContentPart[] = []
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text })
    } else if (part.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${part.mimeType};base64,${part.data}` },
      })
    }
  }
  return parts
}

function baseCapabilities(vision: boolean): BackendCapabilities {
  return {
    prompt: true,
    streaming: false,
    sessionLifecycle: false,
    mcp: true,
    vision,
    skills: true,
    modelSelection: true,
    toolPermissions: 'native',
  }
}

async function runAgentLoop(
  req: AgentRequest,
  ctx: BackendContext,
  opts: {
    baseUrl: string
    apiKey: string | undefined
    defaultModel: string
    timeoutMs: number
    cwd: string
    agentDefRoot: string
    maxTokens: number | undefined
  },
): Promise<{
  text: string
  stopReason?: string | undefined
  usage?: Usage | undefined
}> {
  const model = opts.defaultModel

  const enforcer = ctx.permissions
    ? new TrustEnforcer(ctx.permissions)
    : new TrustEnforcer(createDefaultPolicy(opts.cwd, opts.agentDefRoot))

  const toolCtx: ToolExecutionContext = {
    cwd: opts.cwd,
    agentDefRoot: opts.agentDefRoot,
    enforcer,
    loadSkill: ctx.loadSkill,
    fetch: ctx.fetch,
    secrets: req.secrets,
    signal: ctx.signal,
    events: ctx.permissions
      ? {
          publish: () => {
            /* audit handled by runner */
          },
        }
      : undefined,
  }

  // The runtime only builds an mcpHost for backends with toolPermissions:
  // 'wrapped'. We're 'native', so for step.mcp to actually do anything the
  // backend has to bring up the host itself and tear it down on exit.
  let ownMcpHost: McpHost | undefined
  if (ctx.mcpHost === undefined && req.mcpServers !== undefined && req.mcpServers.length > 0) {
    ownMcpHost = await createMcpHost(req.mcpServers, {
      ...(ctx.permissions !== undefined && { enforcer }),
      // Forward the runner's event bus + identifiers so MCP tool dispatch
      // emits tool.call / tool.result events the runner audits. Without
      // this branch the McpHost's `publishToolCall` short-circuits on
      // undefined `events`/`runId`/`stepId` and the audit log is empty
      // for every MCP-driven native-agent run (F018).
      ...(ctx.events !== undefined && { events: ctx.events }),
      ...(ctx.runId !== undefined && { runId: ctx.runId }),
      ...(ctx.stepId !== undefined && { stepId: ctx.stepId }),
    })
  }
  const mcpHost = ctx.mcpHost ?? ownMcpHost

  try {
    // Surface every MCP tool the host has bridged in alongside the built-ins,
    // so the model actually knows it can call them. Without this the agent
    // loop's else-if (mcpHost) branch below is dead: the model never sees
    // the namespaced "<serverId>.<toolName>" names and only falls back to the
    // built-in tools (F016).
    const mcpRawTools = mcpHost ? await mcpHost.listTools() : []
    const mcpTools = mcpRawTools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.id,
        ...(t.description !== undefined && { description: t.description }),
        ...(isObjectSchema(t.inputSchema) && { parameters: t.inputSchema }),
      },
    }))
    const tools = [...BUILTIN_TOOLS.map(toOpenAITool), ...mcpTools]

    // Build a real system prompt and prepend it. Aggregate built-in + MCP tools,
    // resolve skill summaries (body fetched on demand via fs_read), and tag the
    // MCP servers so the model knows the namespacing convention.
    const promptTools: Array<{ name: string; description?: string }> = [
      ...BUILTIN_TOOLS.map((t) => ({
        name: t.name,
        ...(t.description !== undefined && { description: t.description }),
      })),
      ...mcpRawTools.map((t) => ({
        name: t.id,
        ...(t.description !== undefined && { description: t.description }),
      })),
    ]
    const skillSummaries: Array<{ name: string; description: string; location?: string }> = []
    if (req.skills && req.skills.length > 0 && ctx.loadSkill !== undefined) {
      for (const skillId of req.skills) {
        const skill = await ctx.loadSkill(skillId)
        if (skill !== null) {
          skillSummaries.push({
            name: skill.id,
            description: skill.description ?? '',
            location: skill.source,
          })
        }
      }
    }
    const mcpServerSummaries =
      req.mcpServers && req.mcpServers.length > 0
        ? req.mcpServers.map((s) => ({
            id: s.id,
            toolCount: mcpRawTools.filter((t) => t.id.startsWith(`${s.id}.`)).length,
          }))
        : undefined

    const systemContent = buildSystemPromptFromRequest(req, {
      cwd: opts.cwd,
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
      model,
      tools: promptTools,
      ...(skillSummaries.length > 0 && { skills: skillSummaries }),
      ...(mcpServerSummaries && { mcpServers: mcpServerSummaries }),
    })

    const messages: OpenAIMessage[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: toOpenAIChatContent(req.prompt) },
    ]

    const maxTurns = req.maxTurns ?? 30
    let turn = 0

    while (turn < maxTurns) {
      turn++

      const response = await chatCompletion(opts.baseUrl, {
        apiKey: opts.apiKey,
        model,
        messages,
        temperature: undefined,
        maxTokens: opts.maxTokens,
        tools,
        responseFormat: undefined,
        signal: ctx.signal,
        timeoutMs: opts.timeoutMs,
      })

      const choice = response.choices?.[0]
      if (!choice?.message) {
        throw new Error('LLM returned empty response')
      }

      const toolCalls = choice.message.tool_calls
      if (!toolCalls || toolCalls.length === 0) {
        const content = choice.message.content
        const text = typeof content === 'string' ? content : content !== null ? String(content) : ''
        const reasoning = choice.message.reasoning_content
        return {
          text,
          stopReason: choice.finish_reason ?? 'stop',
          ...(typeof reasoning === 'string' && reasoning.length > 0 && { reasoning }),
          usage: toUsage(response.usage),
        }
      }

      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      }
      messages.push(assistantMsg)

      for (const tc of toolCalls) {
        let parsedArgs: unknown = {}
        try {
          parsedArgs = JSON.parse(tc.function.arguments)
        } catch {
          // pass
        }

        const builtinTool = BUILTIN_TOOLS.find((t) => t.name === tc.function.name)

        let result: ToolResult
        if (builtinTool) {
          result = await builtinTool.handler(parsedArgs, toolCtx)
        } else if (mcpHost) {
          try {
            const toolDecision = enforcer.canCallTool(tc.function.name)
            if (!toolDecision.allow) {
              result = { content: `Permission denied: ${toolDecision.reason}`, isError: true }
            } else {
              const mcpResult = await mcpHost.invokeTool(tc.function.name, parsedArgs, ctx.signal)
              const textParts = mcpResult.content
                .filter((c) => c.type === 'text')
                .map((c) => (c as { type: 'text'; text: string }).text)
              result = { content: textParts.join('') }
            }
          } catch (err) {
            result = { content: `MCP error: ${(err as Error).message}`, isError: true }
          }
        } else {
          result = { content: `Unknown tool: ${tc.function.name}`, isError: true }
        }

        messages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: tc.id,
        })
      }
    }

    throw new Error(`Agent exceeded max turns (${maxTurns})`)
  } finally {
    if (ownMcpHost !== undefined) await ownMcpHost.dispose()
  }
}

/**
 * Create a SkelmBackend that implements the agent() and llm() steps
 * using a native OpenAI-compatible chat loop with built-in permission
 * enforcement.
 */
export function createSkelmAgentBackend(opts: SkelmAgentOptions): SkelmBackend {
  const resolvedId = opts.id ?? 'agent'

  // Vision capability is a user-declared opt-in/out: default is `true`
  // (forward image content to the upstream and let it succeed or fail
  // loudly). Set `vision: false` to flip on the framework's vision gate so
  // image prompts are rejected at step start with no HTTP egress.
  const capabilities = baseCapabilities(opts.vision ?? true)

  const backend: SkelmBackend = {
    id: resolvedId,
    capabilities,

    async infer(req: InferRequest, ctx: BackendContext): Promise<InferResponse> {
      const route = resolveCallModel(opts, req.model)
      const baseUrl = route.kind === 'registry' ? route.resolved.baseUrl : route.baseUrl
      const apiKey = route.kind === 'registry' ? route.resolved.apiKey : route.apiKey
      const model = route.kind === 'registry' ? route.resolved.entry.id : route.modelId
      const perCallMax =
        (req.maxTokens as number | undefined) ??
        (route.kind === 'registry' ? route.resolved.entry.maxTokens : undefined) ??
        opts.maxTokens

      const messages: OpenAIMessage[] = []
      if (req.system) {
        messages.push({ role: 'system', content: req.system })
      }
      for (const msg of req.messages) {
        messages.push({
          role: msg.role as OpenAIMessage['role'],
          content: toOpenAIChatContent(msg.content),
        })
      }

      const response = await chatCompletion(baseUrl, {
        apiKey,
        model,
        messages,
        temperature: req.temperature as number | undefined,
        // Per-call req.maxTokens (llm step input) wins; otherwise fall back
        // to the registry entry's maxTokens, then the backend-level default.
        // Any may be undefined → upstream picks its own default.
        maxTokens: perCallMax,
        responseFormat: req.outputSchema !== undefined ? { type: 'json_object' } : undefined,
        tools: undefined,
        signal: ctx.signal,
        timeoutMs: opts.timeoutMs ?? 300_000,
      })

      const rawChoice = response.choices?.[0]
      const choice = rawChoice?.message
      const finishReason = rawChoice?.finish_reason
      const reasoning = choice?.reasoning_content ?? undefined
      const content = choice?.content ?? ''
      const usage = toUsage(response.usage)

      // Distinguish three cases when `content` is empty:
      //   1. `finish_reason === 'length'` → the `max_tokens` cap fit
      //      inside the model's reasoning block (Qwen 3.x / DeepSeek-R1
      //      / o1-style). Surface as `LLMTruncatedError` so callers can
      //      retry with a larger cap or inspect `reasoning`.
      //   2. No choice / no message at all → the upstream really did
      //      return nothing usable. Fall back to the generic error.
      //   3. Empty content but a real `finish_reason: 'stop'` → return
      //      the empty text with `finishReason` populated; the model
      //      legitimately had nothing to say (e.g. it emitted only
      //      reasoning and decided that was sufficient).
      if (content === '') {
        if (finishReason === 'length') {
          const suffix =
            reasoning !== undefined
              ? ' (model produced reasoning but no final answer — consider raising maxTokens or routing to a non-reasoning model)'
              : ''
          throw new LLMTruncatedError(
            `LLM stopped because it hit \`max_tokens\` before emitting any assistant content${suffix}`,
            finishReason,
            reasoning,
          )
        }
        if (!choice) {
          throw new Error('LLM returned empty response')
        }
      }

      if (req.outputSchema !== undefined) {
        try {
          const structured = JSON.parse(content)
          return {
            text: content,
            structured,
            ...(reasoning !== undefined && reasoning.length > 0 && { reasoning }),
            ...(finishReason !== undefined && { finishReason }),
            ...(usage && { usage }),
          }
        } catch {
          return {
            text: content,
            ...(reasoning !== undefined && reasoning.length > 0 && { reasoning }),
            ...(finishReason !== undefined && { finishReason }),
            ...(usage && { usage }),
          }
        }
      }

      return {
        text: content,
        ...(reasoning !== undefined && reasoning.length > 0 && { reasoning }),
        ...(finishReason !== undefined && { finishReason }),
        ...(usage && { usage }),
      }
    },

    async run(req: AgentRequest, ctx: BackendContext): Promise<AgentResponse> {
      const cwd = req.cwd ?? process.cwd()
      const agentDefRoot = cwd
      // AgentRequest has no `model` field, so the agent-loop path always
      // uses the backend's defaultModel (or opts.model in single-endpoint
      // mode). Per-call model routing is only available on the infer() path
      // via InferRequest.model. To switch models within an agent run, build
      // a separate backend instance per model.
      const route = resolveCallModel(opts, undefined)
      const baseUrl = route.kind === 'registry' ? route.resolved.baseUrl : route.baseUrl
      const apiKey = route.kind === 'registry' ? route.resolved.apiKey : route.apiKey
      const model = route.kind === 'registry' ? route.resolved.entry.id : route.modelId
      const perCallMax =
        (route.kind === 'registry' ? route.resolved.entry.maxTokens : undefined) ?? opts.maxTokens

      const result = await runAgentLoop(req, ctx, {
        baseUrl,
        apiKey,
        defaultModel: model,
        timeoutMs: opts.timeoutMs ?? 300_000,
        cwd,
        agentDefRoot,
        maxTokens: perCallMax,
      })

      let structured: unknown | undefined
      if (req.outputSchema !== undefined) {
        try {
          structured = JSON.parse(result.text)
        } catch {
          // Runtime will validate and report SchemaValidationError
        }
      }

      return {
        text: result.text,
        ...(structured !== undefined && structured !== result.text && { structured }),
        ...(result.stopReason !== undefined && { stopReason: result.stopReason }),
        ...(result.usage !== undefined && { usage: result.usage }),
      }
    },

    async dispose(): Promise<void> {
      // No state to clean up
    },
  }

  if (opts.label !== undefined) {
    Object.defineProperty(backend, 'label', { value: opts.label })
  }

  return backend
}
