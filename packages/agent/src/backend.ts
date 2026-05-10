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

import { mkdir, readdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import type {
  AgentRequest,
  AgentResponse,
  BackendCapabilities,
  BackendContext,
  InferRequest,
  InferResponse,
  PromptMessage,
  SkelmBackend,
  Usage,
} from '@skelm/core/backend'
import type {
  EnforceDecision,
  PermissionDimension,
  ResolvedPolicy,
} from '@skelm/core/permissions'
import { TrustEnforcer } from '@skelm/core/permissions'
import type { SkelmSchema } from '@skelm/core/schema'
import type { Skill } from '@skelm/core/skills'

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

// ---------------------------------------------------------------------------
// Default policy helpers (when no explicit permissions are provided)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const capabilities: BackendCapabilities = {
  prompt: true,
  streaming: false,
  sessionLifecycle: false,
  mcp: true,
  skills: true,
  modelSelection: true,
  toolPermissions: 'native',
}

// ---------------------------------------------------------------------------
// OpenAI-compatible HTTP client
// ---------------------------------------------------------------------------

interface OpenAIErrorResponse {
  error?: {
    message?: string
    type?: string
    code?: string
  }
}

interface OpenAIChatResponse {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: Array<{
    index?: number
    message?: {
      role?: string
      content?: string | null
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

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  name?: string
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

async function chatCompletion(
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
    headers['Authorization'] = `Bearer ${opts.apiKey}`
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
  const combinedSignal = opts.signal
    ? AbortSignal.any([timeoutSignal, opts.signal])
    : timeoutSignal

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
    throw new Error(`OpenAI-compatible request failed (${res.status}): ${errMsg}`)
  }

  return (await res.json()) as OpenAIChatResponse
}

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

interface ToolResult {
  content: string
  isError?: boolean
}

interface ToolExecutionContext {
  cwd: string
  agentDefRoot: string
  enforcer: TrustEnforcer
  loadSkill?: ((skillId: string) => Promise<Skill | null>) | undefined
  fetch?: typeof globalThis.fetch | undefined
  secrets?: Readonly<Record<string, string>> | undefined
  events?: {
    publish: (ev: unknown) => void
    runId?: string
    stepId?: string
  } | undefined
}

type ToolHandler = (
  args: unknown,
  ctx: ToolExecutionContext,
) => Promise<ToolResult>

interface BuiltInToolDef {
  name: string
  description: string
  parameters?: Record<string, unknown>
  handler: ToolHandler
}

function normalizePath(
  input: string,
  cwd: string,
  agentDefRoot: string,
): string {
  const resolved = isAbsolute(input) ? resolve(input) : resolve(cwd, input)
  if (!resolved.startsWith(cwd + '/') && resolved !== cwd) {
    if (!resolved.startsWith(agentDefRoot + '/') && resolved !== agentDefRoot) {
      throw new Error(
        `Path escape: ${resolved} is outside workspace (${cwd}) and agentDefRoot (${agentDefRoot})`,
      )
    }
  }
  return resolved
}

function requireParentDir(filepath: string): string {
  const lastSlash = filepath.lastIndexOf('/')
  return lastSlash > 0 ? filepath.slice(0, lastSlash) : '.'
}

// Permission denial event helper
function publishDenied(
  events: ToolExecutionContext['events'],
  dimension: PermissionDimension,
  detail: string,
): void {
  if (!events) return
  events.publish({
    type: 'permission.denied' as const,
    ...(events.runId ? { runId: events.runId } : {}),
    ...(events.stepId ? { stepId: events.stepId } : {}),
    dimension,
    detail,
    at: Date.now(),
  })
}

const BUILTIN_TOOLS: BuiltInToolDef[] = [
  // ---- fs_read ----
  {
    name: 'fs_read',
    description:
      'Read the contents of a text file. Use for reading config files, source code, logs, documentation, or any text-based file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read.',
        },
      },
      required: ['path'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { path: string }
      if (!p.path) return { content: 'Error: path is required', isError: true }
      try {
        const resolved = normalizePath(p.path, ctx.cwd, ctx.agentDefRoot)
        const decision = ctx.enforcer.canRead(resolved)
        if (!decision.allow) {
          publishDenied(ctx.events, 'fs.read', `fs_read denied: ${resolved} — ${decision.reason}`)
          return { content: `Permission denied: ${decision.reason}`, isError: true }
        }
        const content = await readFile(resolved, 'utf-8')
        return { content }
      } catch (err) {
        return { content: `Error reading file: ${(err as Error).message}`, isError: true }
      }
    },
  },

  // ---- fs_read_glob ----
  {
    name: 'fs_read_glob',
    description:
      'List files in a directory. Supports a simple pattern filter (no recursive glob in stdlib).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory to list.',
        },
        pattern: {
          type: 'string',
          description: 'Optional glob pattern filter (e.g. "*.ts").',
        },
      },
      required: ['path'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { path: string; pattern?: string }
      try {
        const resolved = normalizePath(p.path, ctx.cwd, ctx.agentDefRoot)
        const decision = ctx.enforcer.canRead(resolved)
        if (!decision.allow) {
          publishDenied(ctx.events, 'fs.read', `fs_read_glob denied: ${resolved} — ${decision.reason}`)
          return { content: `Permission denied: ${decision.reason}`, isError: true }
        }
        const entries = await readdir(resolved, { withFileTypes: true })
        let names = entries
          .map((e) => `${e.isDirectory() ? '📁 ' : '📄 '}${e.name}`)
        if (p.pattern) {
          const regex = new RegExp('^' + p.pattern.replace(/\*/g, '.*') + '$')
          names = names.filter((n) => regex.test(n.split(' ')[1] ?? n))
        }
        return { content: names.join('\n') || '(empty)' }
      } catch (err) {
        return { content: `Error listing directory: ${(err as Error).message}`, isError: true }
      }
    },
  },

  // ---- fs_write ----
  {
    name: 'fs_write',
    description:
      'Write or overwrite a file. Creates parent directories if they do not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to write.',
        },
        content: {
          type: 'string',
          description: 'File contents to write.',
        },
      },
      required: ['path', 'content'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { path: string; content: string }
      if (!p.path) return { content: 'Error: path is required', isError: true }
      try {
        const resolved = normalizePath(p.path, ctx.cwd, ctx.agentDefRoot)
        const decision = ctx.enforcer.canWrite(resolved)
        if (!decision.allow) {
          publishDenied(ctx.events, 'fs.write', `fs_write denied: ${resolved} — ${decision.reason}`)
          return { content: `Permission denied: ${decision.reason}`, isError: true }
        }
        const parent = requireParentDir(resolved)
        await mkdir(parent, { recursive: true })
        await writeFile(resolved, p.content, 'utf-8')
        return { content: `Written ${resolved} (${p.content.length} bytes)` }
      } catch (err) {
        return { content: `Error writing file: ${(err as Error).message}`, isError: true }
      }
    },
  },

  // ---- fs_append ----
  {
    name: 'fs_append',
    description:
      'Append text to the end of an existing file. Creates the file if it does not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file.',
        },
        content: {
          type: 'string',
          description: 'Text to append.',
        },
      },
      required: ['path', 'content'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { path: string; content: string }
      if (!p.path) return { content: 'Error: path is required', isError: true }
      try {
        const resolved = normalizePath(p.path, ctx.cwd, ctx.agentDefRoot)
        const decision = ctx.enforcer.canWrite(resolved)
        if (!decision.allow) {
          publishDenied(ctx.events, 'fs.write', `fs_append denied: ${resolved} — ${decision.reason}`)
          return { content: `Permission denied: ${decision.reason}`, isError: true }
        }
        const parent = requireParentDir(resolved)
        await mkdir(parent, { recursive: true })
        await appendFile(resolved, p.content, 'utf-8')
        return { content: `Appended to ${resolved} (${p.content.length} bytes)` }
      } catch (err) {
        return { content: `Error appending to file: ${(err as Error).message}`, isError: true }
      }
    },
  },

  // ---- http_fetch ----
  {
    name: 'http_fetch',
    description:
      'Make an HTTP/HTTPS request. Supports GET, POST, PUT, DELETE, PATCH.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to request.',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
          description: 'HTTP method (default: GET).',
        },
        headers: {
          type: 'object',
          description: 'Optional HTTP headers.',
        },
        body: {
          type: 'string',
          description: 'Request body (for POST/PUT/PATCH).',
        },
      },
      required: ['url'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { url: string; method?: string; headers?: Record<string, string>; body?: string }
      if (!p.url) return { content: 'Error: url is required', isError: true }

      let hostname: string
      try {
        const urlObj = new URL(p.url)
        hostname = urlObj.hostname
      } catch {
        return { content: `Error: invalid URL "${p.url}"`, isError: true }
      }

      const decision = ctx.enforcer.canFetch(hostname)
      if (!decision.allow) {
        publishDenied(ctx.events, 'network', `http_fetch denied: ${hostname} — ${decision.reason}`)
        return { content: `Permission denied: ${decision.reason}`, isError: true }
      }

      const fetchFn = ctx.fetch ?? globalThis.fetch
      const init: RequestInit = {
        method: p.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(p.headers ?? {}),
        },
      }
      if (p.body !== undefined) {
        init.body = p.body
      }

      try {
        const res = await fetchFn(p.url, init)
        const text = await res.text()
        const result: Record<string, unknown> = {
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries()),
          body: text.length > 4096 ? text.slice(0, 4096) + '\n… (truncated)' : text,
        }
        return { content: JSON.stringify(result, null, 2) }
      } catch (err) {
        return { content: `Error fetching ${p.url}: ${(err as Error).message}`, isError: true }
      }
    },
  },

  // ---- ls ----
  {
    name: 'ls',
    description:
      'List files and directories. Supports recursive listing with --recursive flag.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory to list (default: current working directory).',
        },
        recursive: {
          type: 'boolean',
          description: 'List recursively.',
        },
      },
      required: [],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { path?: string; recursive?: boolean }
      try {
        const target = p.path
          ? normalizePath(p.path, ctx.cwd, ctx.agentDefRoot)
          : ctx.cwd
        const decision = ctx.enforcer.canRead(target)
        if (!decision.allow) {
          return { content: `Permission denied: ${decision.reason}`, isError: true }
        }
        const entries = await readdir(target, { withFileTypes: true })
        const lines = entries
          .map((e) => `${e.isDirectory() ? '📁 ' : '📄 '}${e.name}`)
          .join('\n')
        return { content: lines || '(empty)' }
      } catch (err) {
        return { content: `Error listing: ${(err as Error).message}`, isError: true }
      }
    },
  },

  // ---- get_secret ----
  {
    name: 'get_secret',
    description:
      'Retrieve a secret value by name. Secrets are injected by the skelm runner and are never logged.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The secret name to look up.',
        },
      },
      required: ['name'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { name: string }
      if (!p.name) return { content: 'Error: name is required', isError: true }
      const secrets = ctx.secrets
      if (!secrets) return { content: 'Error: no secrets available for this step', isError: true }
      if (!(p.name in secrets)) {
        return { content: `Error: secret "${p.name}" not found`, isError: true }
      }
      return { content: `Secret "${p.name}" is available (value masked for security)` }
    },
  },

  // ---- load_skill ----
  {
    name: 'load_skill',
    description:
      'Load a skelm skill by ID. Returns skill metadata if allowed by the permission policy.',
    parameters: {
      type: 'object',
      properties: {
        skillId: {
          type: 'string',
          description: 'The skill identifier to load.',
        },
      },
      required: ['skillId'],
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      const p = args as { skillId: string }
      if (!p.skillId) return { content: 'Error: skillId is required', isError: true }
      const skill = ctx.loadSkill ? await ctx.loadSkill(p.skillId) : null
      if (!skill) {
        return { content: `Skill "${p.skillId}" not found or not accessible`, isError: true }
      }
      const info: Record<string, unknown> = {
        id: skill.id,
        name: skill.id,
        description: skill.description,
      }
      if (skill.metadata['allowed-tools']) {
        info['allowedTools'] = skill.metadata['allowed-tools']
      }
      if (skill.metadata.compatibility) {
        info.compatibility = skill.metadata.compatibility
      }
      return { content: JSON.stringify(info, null, 2) }
    },
  },
]

// ---------------------------------------------------------------------------
// OpenAI message / tool builders
// ---------------------------------------------------------------------------

function toOpenAITool(tool: BuiltInToolDef): OpenAITool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      ...(tool.parameters && { parameters: tool.parameters }),
    },
  }
}

function toUsage(
  usage?: OpenAIChatResponse['usage'],
): Usage | undefined {
  if (!usage) return undefined
  return {
    ...(usage.prompt_tokens !== undefined && { inputTokens: usage.prompt_tokens }),
    ...(usage.completion_tokens !== undefined && { outputTokens: usage.completion_tokens }),
    ...(usage.total_tokens !== undefined && {
      extras: { totalTokens: usage.total_tokens },
    }),
  }
}

// ---------------------------------------------------------------------------
// Build system prompt with AGENTS.md / SOUL.md + tool instructions
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  req: AgentRequest,
  cwd: string,
  hasMcpServers: boolean,
  toolCount: number,
): string {
  const parts: string[] = []

  // AGENTS.md / SOUL.md
  if (req.agentDef) {
    if (req.agentDef.soul) {
      parts.push(`# SOUL.md\n${req.agentDef.soul}`)
    }
    parts.push(`# AGENTS.md\n${req.agentDef.instructions}`)
  }

  // Step-level system prompt
  if (req.system) {
    parts.push(`# Instructions\n${req.system}`)
  }

  // Tool-use instructions
  parts.push(
    '\n# Tool Use\n\n' +
    `You have access to ${toolCount} tool(s). Use them when appropriate.\n` +
    `Your working directory is: ${cwd}\n` +
    `When you need to use a tool, issue a tool call. When the task is complete, respond with your final answer.`,
  )

  if (hasMcpServers) {
    parts.push(
      '\nYou may also have access to MCP servers with additional tools. Use those when appropriate.',
    )
  }

  return parts.join('\n\n---\n\n')
}

// ---------------------------------------------------------------------------
// Agent loop: multi-turn LLM + tool use with permission enforcement
// ---------------------------------------------------------------------------

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
  const systemPrompt = buildSystemPrompt(req, opts.cwd, false, BUILTIN_TOOLS.length)

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
    events: ctx.permissions
      ? {
          publish: () => { /* audit handled by runner */ },
        }
      : undefined,
  }

  // Build initial messages
  const messages: OpenAIMessage[] = [
    { role: 'user', content: req.prompt },
  ]

  const maxTurns = req.maxTurns ?? 30
  let turn = 0

  while (turn < maxTurns) {
    turn++

    // Send to LLM with all tools available
    const response = await chatCompletion(opts.baseUrl, {
      apiKey: opts.apiKey,
      model,
      messages,
      temperature: undefined as number | undefined,
      maxTokens: undefined as number | undefined,
      tools: BUILTIN_TOOLS.map(toOpenAITool),
      responseFormat: undefined,
      signal: ctx.signal,
      timeoutMs: opts.timeoutMs,
    })

    const choice = response.choices?.[0]
    if (!choice?.message) {
      throw new Error('LLM returned empty response')
    }

    // Check for tool calls
    const toolCalls = choice.message.tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      // Final answer
      const content = choice.message.content
      const text = typeof content === 'string' ? content : (content !== null ? String(content) : '')
      return {
        text,
        stopReason: choice.finish_reason ?? 'stop',
        usage: toUsage(response.usage),
      }
    }

    // Build assistant message with tool calls
    const assistantMsg: OpenAIMessage = {
      role: 'assistant',
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    }
    messages.push(assistantMsg)

    // Execute each tool call
    for (const tc of toolCalls) {
      // Parse arguments
      let parsedArgs: unknown = {}
      try {
        parsedArgs = JSON.parse(tc.function.arguments)
      } catch {
        // pass
      }

      // Find built-in tool
      const builtinTool = BUILTIN_TOOLS.find((t) => t.name === tc.function.name)

      let result: ToolResult
      if (builtinTool) {
        result = await builtinTool.handler(parsedArgs, toolCtx)
      } else {
        // Check MCP host for unknown tools
        if (ctx.mcpHost) {
          try {
            const toolDecision = enforcer.canCallTool(tc.function.name)
            if (!toolDecision.allow) {
              result = { content: `Permission denied: ${toolDecision.reason}`, isError: true }
            } else {
              const mcpResult = await ctx.mcpHost.invokeTool(
                tc.function.name,
                parsedArgs,
                ctx.signal,
              )
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
      }

      // Add tool result message
      messages.push({
        role: 'tool',
        content: result.content,
        tool_call_id: tc.id,
      })
    }
  }

  throw new Error(`Agent exceeded max turns (${maxTurns})`)
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a SkelmBackend that implements the agent() and llm() steps
 * using a native OpenAI-compatible chat loop with built-in permission
 * enforcement.
 *
 * @example
 * ```ts
 * import { createSkelmAgentBackend } from '@skelm/agent'
 * import { BackendRegistry } from '@skelm/core'
 *
 * const registry = new BackendRegistry()
 * registry.register(createSkelmAgentBackend({
 *   baseUrl: 'http://localhost:8000',
 *   model: 'qwen36',
 * }))
 * ```
 */
export function createSkelmAgentBackend(
  opts: SkelmAgentOptions,
): SkelmBackend {
  const resolvedId = opts.id ?? 'agent'

  const backend: SkelmBackend = {
    id: resolvedId,
    capabilities,

    // Single-shot LLM inference (llm steps)
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
        responseFormat: req.outputSchema !== undefined
          ? { type: 'json_object' }
          : undefined,
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

    // Multi-turn agent loop (agent steps)
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

      // Validate structured output if requested
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
