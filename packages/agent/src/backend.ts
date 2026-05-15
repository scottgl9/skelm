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

import { type McpHost, createMcpHost } from '@skelm/core'
import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  InferRequest,
  InferResponse,
  SkelmBackend,
  Usage,
} from '@skelm/core/backend'
import type { ResolvedPolicy } from '@skelm/core/permissions'
import { TrustEnforcer } from '@skelm/core/permissions'

import { type OpenAIMessage, chatCompletion } from './http-client.js'
import { buildSystemPromptFromRequest, toUsage } from './prompt.js'
import { BUILTIN_TOOLS, type ToolExecutionContext, type ToolResult, toOpenAITool } from './tools.js'

export interface SkelmAgentOptions {
  /** Backend id. Defaults to 'agent' when only one is registered. */
  id?: string
  /** Human-readable label for diagnostics. */
  label?: string
  /** Base URL of an OpenAI-compatible chat completions endpoint. */
  baseUrl: string
  /** API key (required for most providers). */
  apiKey?: string
  /** Default model id used when the step doesn't specify one. */
  model?: string
  /** Timeout in milliseconds for LLM HTTP requests (default 300 000 = 5 min). */
  timeoutMs?: number
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

const capabilities: BackendCapabilities = {
  prompt: true,
  streaming: false,
  sessionLifecycle: false,
  mcp: true,
  skills: true,
  modelSelection: true,
  toolPermissions: 'native',
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
      { role: 'user', content: req.prompt },
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
        maxTokens: undefined,
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
        return {
          text,
          stopReason: choice.finish_reason ?? 'stop',
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

  const backend: SkelmBackend = {
    id: resolvedId,
    capabilities,

    async infer(req: InferRequest, ctx: BackendContext): Promise<InferResponse> {
      const model = req.model ?? opts.model ?? 'qwen36'

      const messages: OpenAIMessage[] = []
      if (req.system) {
        messages.push({ role: 'system', content: req.system })
      }
      for (const msg of req.messages) {
        messages.push({
          role: msg.role as OpenAIMessage['role'],
          content: msg.content,
        })
      }

      const response = await chatCompletion(opts.baseUrl, {
        apiKey: opts.apiKey,
        model,
        messages,
        temperature: req.temperature as number | undefined,
        maxTokens: req.maxTokens as number | undefined,
        responseFormat: req.outputSchema !== undefined ? { type: 'json_object' } : undefined,
        tools: undefined,
        signal: ctx.signal,
        timeoutMs: opts.timeoutMs ?? 300_000,
      })

      const choice = response.choices?.[0]?.message
      if (!choice?.content) {
        throw new Error('LLM returned empty response')
      }

      const usage = toUsage(response.usage)

      if (req.outputSchema !== undefined) {
        try {
          const structured = JSON.parse(choice.content)
          return {
            text: choice.content,
            structured,
            ...(usage && { usage }),
          }
        } catch {
          return {
            text: choice.content,
            ...(usage && { usage }),
          }
        }
      }

      return {
        text: choice.content,
        ...(usage && { usage }),
      }
    },

    async run(req: AgentRequest, ctx: BackendContext): Promise<AgentResponse> {
      const cwd = req.cwd ?? process.cwd()
      const agentDefRoot = cwd

      const result = await runAgentLoop(req, ctx, {
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        defaultModel: opts.model ?? 'qwen36',
        timeoutMs: opts.timeoutMs ?? 300_000,
        cwd,
        agentDefRoot,
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
