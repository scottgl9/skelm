import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackendRegistry } from '@skelm/core/backend'
import { resolvePermissions } from '@skelm/core/permissions'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSkelmAgentBackend } from '../src/index.js'

// ---------------------------------------------------------------------------
// OpenAI-compatible response builder + fetch mock
// ---------------------------------------------------------------------------

interface ToolCallStub {
  id?: string
  name: string
  arguments: Record<string, unknown>
}

interface TurnStub {
  content?: string | null
  reasoningContent?: string
  toolCalls?: readonly ToolCallStub[]
  finishReason?: string
}

function buildChatResponse(turn: TurnStub): unknown {
  const choice: Record<string, unknown> = {
    index: 0,
    message: {
      role: 'assistant',
      content: turn.content ?? '',
      ...(turn.reasoningContent !== undefined && { reasoning_content: turn.reasoningContent }),
      ...(turn.toolCalls && {
        tool_calls: turn.toolCalls.map((tc, i) => ({
          id: tc.id ?? `call_${i}`,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      }),
    },
    finish_reason: turn.finishReason ?? (turn.toolCalls ? 'tool_calls' : 'stop'),
  }
  return {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    model: 'mock-model',
    choices: [choice],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

function stubFetch(turns: readonly TurnStub[]): ReturnType<typeof vi.fn> {
  const queue = [...turns]
  const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown): Promise<Response> => {
    const next = queue.shift() ?? turns[turns.length - 1]
    if (next === undefined) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(buildChatResponse(next)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

// ---------------------------------------------------------------------------
// Permission policy helpers
// ---------------------------------------------------------------------------

function makePolicy(overrides: Parameters<typeof resolvePermissions>[0] = {}) {
  return resolvePermissions(
    {
      allowedTools: ['*'],
      allowedExecutables: [],
      allowedSkills: [],
      allowedMcpServers: [],
      allowedSecrets: [],
      fsRead: [process.cwd()],
      fsWrite: [process.cwd()],
      networkEgress: 'deny',
      ...overrides,
    },
    undefined,
  )
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Static / construction tests (no network)
// ---------------------------------------------------------------------------

describe('createSkelmAgentBackend', () => {
  it('creates a backend with correct id and capabilities', () => {
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      id: 'test-agent',
      label: 'Test Agent',
    })

    expect(backend.id).toBe('test-agent')
    expect(backend.capabilities.prompt).toBe(true)
    expect(backend.capabilities.streaming).toBe(false)
    expect(backend.capabilities.mcp).toBe(true)
    expect(backend.capabilities.skills).toBe(true)
    expect(backend.capabilities.modelSelection).toBe(true)
    expect(backend.capabilities.toolPermissions).toBe('native')
  })

  it('defaults id to "agent"', () => {
    const backend = createSkelmAgentBackend({ baseUrl: 'http://example.invalid' })
    expect(backend.id).toBe('agent')
  })
})

// ---------------------------------------------------------------------------
// inference() — single-shot LLM inference
// ---------------------------------------------------------------------------

describe('SkelmAgentBackend — infer (mocked)', () => {
  const backend = createSkelmAgentBackend({
    baseUrl: 'http://example.invalid',
    model: 'mock-model',
  })

  it('returns the assistant content for a simple prompt', async () => {
    stubFetch([{ content: '4' }])

    const response = await backend.inference?.(
      { messages: [{ role: 'user', content: 'What is 2 + 2?' }] },
      { signal: new AbortController().signal },
    )

    expect(response?.text).toBe('4')
    expect(response?.usage?.inputTokens).toBe(10)
    expect(response?.usage?.outputTokens).toBe(5)
  })

  it('requests JSON object mode and parses structured output', async () => {
    const fetchSpy = stubFetch([{ content: '{"answer":"4"}' }])

    const response = await backend.inference?.(
      {
        messages: [{ role: 'user', content: 'What is 2 + 2?' }],
        outputSchema: { type: 'object', properties: { answer: { type: 'string' } } } as never,
      },
      { signal: new AbortController().signal },
    )

    expect(response?.text).toBe('{"answer":"4"}')
    expect(response?.structured).toEqual({ answer: '4' })

    // Verify request body asked for json_object format
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body) as {
      response_format?: { type: string }
    }
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('forwards Authorization when apiKey is set', async () => {
    const apiKeyed = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      apiKey: 'sk-test',
      model: 'mock-model',
    })
    const fetchSpy = stubFetch([{ content: 'ok' }])

    await apiKeyed.inference?.(
      { messages: [{ role: 'user', content: 'ping' }] },
      { signal: new AbortController().signal },
    )

    const headers = (fetchSpy.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer sk-test')
  })

  it('forwards custom LLM request headers', async () => {
    const headered = createSkelmAgentBackend({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test',
      model: 'openai/gpt-5.2',
      headers: {
        'HTTP-Referer': 'https://skelm.dev',
        'X-OpenRouter-Title': 'skelm',
      },
    })
    const fetchSpy = stubFetch([{ content: 'ok' }])

    await headered.inference?.(
      { messages: [{ role: 'user', content: 'ping' }] },
      { signal: new AbortController().signal },
    )

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/chat/completions')
    const headers = (fetchSpy.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer sk-test')
    expect(headers['HTTP-Referer']).toBe('https://skelm.dev')
    expect(headers['X-OpenRouter-Title']).toBe('skelm')
  })

  it('returns empty text + finishReason="stop" when upstream has nothing to say (#182)', async () => {
    // Aligned with the agent-loop path: a clean finish with empty content
    // is a successful inference of empty text, not an error.
    stubFetch([{ content: '' }])

    const result = await backend.inference?.(
      { messages: [{ role: 'user', content: 'x' }] },
      { signal: new AbortController().signal },
    )

    expect(result?.text).toBe('')
    expect(result?.finishReason).toBe('stop')
  })

  it('throws when the upstream returns no message at all', async () => {
    // Genuine "no choice / no message" failure mode — distinct from a
    // clean finish with empty content.
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown): Promise<Response> => {
      return new Response(JSON.stringify({ id: 'x', model: 'm', choices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchSpy)
    await expect(
      backend.inference?.(
        { messages: [{ role: 'user', content: 'x' }] },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/empty response/i)
  })

  it('throws LLMTruncatedError when finish_reason="length" + empty content (#182)', async () => {
    const { LLMTruncatedError } = await import('@skelm/core')
    // Mirrors qwen36 thinking-mode behavior: max_tokens fit inside the
    // model's reasoning block so `content` is "" while `reasoning_content`
    // carries the partial thought.
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown): Promise<Response> => {
      return new Response(
        JSON.stringify({
          id: 'x',
          model: 'qwen36',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                reasoning_content: "Here's a thinking process: 1. analyze ...",
              },
              finish_reason: 'length',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 32, total_tokens: 37 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(
      backend.inference?.(
        { messages: [{ role: 'user', content: 'x' }] },
        { signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(LLMTruncatedError)

    // Round-trip the reasoning + finishReason via the error
    try {
      await backend.inference?.(
        { messages: [{ role: 'user', content: 'x' }] },
        { signal: new AbortController().signal },
      )
      throw new Error('expected throw')
    } catch (err) {
      expect((err as InstanceType<typeof LLMTruncatedError>).finishReason).toBe('length')
      expect((err as InstanceType<typeof LLMTruncatedError>).reasoning).toContain(
        'thinking process',
      )
    }
  })

  it('surfaces reasoning_content on successful InferenceResponse (#182)', async () => {
    const fetchSpy = vi.fn(async (_url: unknown, _init?: unknown): Promise<Response> => {
      return new Response(
        JSON.stringify({
          id: 'x',
          model: 'qwen36',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'final answer',
                reasoning_content: '<think>analyzing</think>',
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await backend.inference?.(
      { messages: [{ role: 'user', content: 'x' }] },
      { signal: new AbortController().signal },
    )

    expect(result?.text).toBe('final answer')
    expect(result?.reasoning).toBe('<think>analyzing</think>')
    expect(result?.finishReason).toBe('stop')
  })

  it('sends options.maxTokens as max_tokens when req.maxTokens is unset', async () => {
    const capped = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      maxTokens: 256,
    })
    const fetchSpy = stubFetch([{ content: 'ok' }])
    await capped.inference?.(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body) as {
      max_tokens?: number
    }
    expect(body.max_tokens).toBe(256)
  })

  it('per-call req.maxTokens overrides options.maxTokens', async () => {
    const capped = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      maxTokens: 256,
    })
    const fetchSpy = stubFetch([{ content: 'ok' }])
    await capped.inference?.(
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 } as never,
      {
        signal: new AbortController().signal,
      },
    )
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body) as {
      max_tokens?: number
    }
    expect(body.max_tokens).toBe(64)
  })

  it('omits max_tokens when neither option nor request sets it', async () => {
    const fetchSpy = stubFetch([{ content: 'ok' }])
    await backend.inference?.(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body) as {
      max_tokens?: number
    }
    expect(body.max_tokens).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// run() — agent tool loop
// ---------------------------------------------------------------------------

describe('SkelmAgentBackend — run / tool loop (mocked)', () => {
  const backend = createSkelmAgentBackend({
    baseUrl: 'http://example.invalid',
    model: 'mock-model',
  })

  it('returns final assistant text when no tool calls are issued', async () => {
    stubFetch([{ content: 'NATIVE_OK' }])

    const response = await backend.run?.(
      { prompt: 'Reply with NATIVE_OK.', maxTurns: 3 },
      { signal: new AbortController().signal, permissions: makePolicy() },
    )

    expect(response?.text).toBe('NATIVE_OK')
    expect(response?.stopReason).toBe('stop')
  })

  it('agent loop honors options.maxTokens on every turn', async () => {
    const capped = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      model: 'mock-model',
      maxTokens: 512,
    })
    const fetchSpy = stubFetch([{ content: 'NATIVE_OK' }])
    await capped.run?.(
      { prompt: 'Reply with NATIVE_OK.', maxTurns: 3 },
      { signal: new AbortController().signal, permissions: makePolicy() },
    )
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body) as {
      max_tokens?: number
    }
    expect(body.max_tokens).toBe(512)
  })

  it('throws LLMTruncatedError when the agent loop gets length finish with no content', async () => {
    const { LLMTruncatedError } = await import('@skelm/core')
    stubFetch([
      {
        content: null,
        reasoningContent: 'thinking only; no final answer yet',
        finishReason: 'length',
      },
    ])

    await expect(
      backend.run?.(
        { prompt: 'Reply briefly.', maxTurns: 3 },
        { signal: new AbortController().signal, permissions: makePolicy() },
      ),
    ).rejects.toBeInstanceOf(LLMTruncatedError)

    try {
      await backend.run?.(
        { prompt: 'Reply briefly.', maxTurns: 3 },
        { signal: new AbortController().signal, permissions: makePolicy() },
      )
      throw new Error('expected throw')
    } catch (err) {
      expect((err as InstanceType<typeof LLMTruncatedError>).finishReason).toBe('length')
      expect((err as InstanceType<typeof LLMTruncatedError>).reasoning).toContain('thinking only')
    }
  })

  it('dispatches a fs_read tool call and feeds the result back into the loop', async () => {
    // Turn 1: model requests fs_read. Turn 2: model responds with content.
    stubFetch([
      {
        toolCalls: [{ name: 'fs_read', arguments: { path: join(process.cwd(), 'package.json') } }],
      },
      { content: 'AGENT_SAW_FS_READ' },
    ])

    const response = await backend.run?.(
      { prompt: 'Read the package.json.', maxTurns: 4 },
      { signal: new AbortController().signal, permissions: makePolicy() },
    )

    expect(response?.text).toBe('AGENT_SAW_FS_READ')
  })

  it('denies fs_read for paths outside fsRead and surfaces the denial', async () => {
    const fetchSpy = stubFetch([
      { toolCalls: [{ name: 'fs_read', arguments: { path: '/etc/passwd' } }] },
      { content: 'I was denied.' },
    ])

    const response = await backend.run?.(
      { prompt: 'Read /etc/passwd', maxTurns: 3 },
      { signal: new AbortController().signal, permissions: makePolicy() },
    )

    expect(response?.text).toBe('I was denied.')
    // Second request body — find the 'tool' role message
    const body2 = JSON.parse((fetchSpy.mock.calls[1]?.[1] as { body: string }).body) as {
      messages: Array<{ role: string; content: string }>
    }
    const toolMsg = body2.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toMatch(/Permission denied|Path escape/)
  })

  it('honors fsRead allowlist for paths outside cwd (F017 regression)', async () => {
    // Seed a real file under /tmp so the read succeeds when policy permits it.
    const dir = await mkdtemp(join(tmpdir(), 'skelm-fsread-out-of-cwd-'))
    const path = join(dir, 'note.txt')
    const { writeFile: wf } = await import('node:fs/promises')
    await wf(path, 'OUT_OF_CWD_OK', 'utf-8')
    try {
      stubFetch([
        { toolCalls: [{ name: 'fs_read', arguments: { path } }] },
        { content: 'AGENT_READ_OUT_OF_CWD' },
      ])

      const response = await backend.run?.(
        { prompt: `Read ${path}.`, maxTurns: 3 },
        {
          signal: new AbortController().signal,
          permissions: makePolicy({ fsRead: [dir], fsWrite: [] }),
        },
      )

      expect(response?.text).toBe('AGENT_READ_OUT_OF_CWD')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lists MCP tools alongside built-ins and dispatches MCP calls (F016 regression)', async () => {
    const mcpHost = {
      listTools: async () => [
        {
          id: 'echo.greet',
          serverId: 'echo',
          name: 'greet',
          description: 'Echo greeting',
          inputSchema: { type: 'object', properties: { who: { type: 'string' } } },
        },
      ],
      invokeTool: async (id: string, args: unknown) => ({
        content: [{ type: 'text' as const, text: `MCP_OK:${id}:${(args as { who: string }).who}` }],
      }),
      dispose: async () => {},
    }
    const fetchSpy = stubFetch([
      { toolCalls: [{ name: 'echo.greet', arguments: { who: 'world' } }] },
      { content: 'AGENT_SAW_MCP' },
    ])

    const response = await backend.run?.(
      { prompt: 'Use echo.greet to greet world.', maxTurns: 3 },
      {
        signal: new AbortController().signal,
        permissions: makePolicy({ allowedMcpServers: ['echo'] }),
        mcpHost,
      },
    )

    expect(response?.text).toBe('AGENT_SAW_MCP')

    // First chat-completion request must advertise echo.greet alongside built-ins.
    const body1 = JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body) as {
      tools: Array<{ function: { name: string } }>
    }
    const advertised = body1.tools.map((t) => t.function.name)
    expect(advertised).toContain('echo.greet')
    expect(advertised).toContain('fs_read')

    // Second turn must reflect the MCP tool result.
    const body2 = JSON.parse((fetchSpy.mock.calls[1]?.[1] as { body: string }).body) as {
      messages: Array<{ role: string; content: string }>
    }
    const toolMsg = body2.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toBe('MCP_OK:echo.greet:world')
  })

  it('throws when maxTurns is exceeded', async () => {
    // Every turn keeps calling fs_read — the loop will hit maxTurns and bail.
    stubFetch([{ toolCalls: [{ name: 'fs_read', arguments: { path: '/nowhere' } }] }])

    await expect(
      backend.run?.(
        { prompt: 'Loop forever.', maxTurns: 2 },
        { signal: new AbortController().signal, permissions: makePolicy() },
      ),
    ).rejects.toThrow(/exceeded max turns/)
  })
})

// ---------------------------------------------------------------------------
// exec tool — gated by allowedExecutables
// ---------------------------------------------------------------------------

describe('SkelmAgentBackend — exec tool (mocked)', () => {
  const backend = createSkelmAgentBackend({
    baseUrl: 'http://example.invalid',
    model: 'mock-model',
  })

  it('refuses exec when allowedExecutables is empty (default-deny)', async () => {
    // Turn 1: exec("echo","DENY_TEST"). Turn 2: model summarizes the failure.
    const fetchSpy = stubFetch([
      {
        toolCalls: [{ name: 'exec', arguments: { command: 'echo', args: ['DENY_TEST'] } }],
      },
      { content: 'exec was denied' },
    ])

    const response = await backend.run?.(
      { prompt: 'exec echo DENY_TEST', maxTurns: 3 },
      {
        signal: new AbortController().signal,
        permissions: makePolicy({ allowedExecutables: [] }),
      },
    )

    expect(response?.text).toBe('exec was denied')
    expect(response?.text).not.toMatch(/DENY_TEST/)

    // Tool message in turn 2 must carry the denial reason from canExec.
    const body2 = JSON.parse((fetchSpy.mock.calls[1]?.[1] as { body: string }).body) as {
      messages: Array<{ role: string; content: string }>
    }
    const toolMsg = body2.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toMatch(/Permission denied: not-in-allowlist/)
  })

  it('runs exec when binary is in allowedExecutables and returns stdout', async () => {
    const fetchSpy = stubFetch([
      {
        toolCalls: [{ name: 'exec', arguments: { command: 'echo', args: ['AGENT_EXEC_OK'] } }],
      },
      { content: 'echoed: AGENT_EXEC_OK' },
    ])

    const response = await backend.run?.(
      { prompt: 'exec echo AGENT_EXEC_OK', maxTurns: 3 },
      {
        signal: new AbortController().signal,
        permissions: makePolicy({ allowedExecutables: ['echo'] }),
      },
    )

    expect(response?.text).toMatch(/AGENT_EXEC_OK/)

    // Tool message in turn 2 must contain the actual echo stdout produced by
    // spawn() — proving the tool ran, not just the model's improvisation.
    const body2 = JSON.parse((fetchSpy.mock.calls[1]?.[1] as { body: string }).body) as {
      messages: Array<{ role: string; content: string }>
    }
    const toolMsg = body2.messages.find((m) => m.role === 'tool')
    const parsed = JSON.parse(toolMsg?.content ?? '{}') as {
      exitCode: number
      stdout: string
    }
    expect(parsed.exitCode).toBe(0)
    expect(parsed.stdout).toMatch(/AGENT_EXEC_OK/)
  })

  it('does NOT expand shell metacharacters in args (spawn shell:false)', async () => {
    // Arg contains `;` which would chain commands under a shell. With
    // shell:false the whole arg is passed literally to echo.
    const dir = await mkdtemp(join(tmpdir(), 'skelm-agent-exec-'))
    try {
      const fetchSpy = stubFetch([
        {
          toolCalls: [
            {
              name: 'exec',
              arguments: {
                command: 'echo',
                // If a shell were involved, `; touch evil` would create an
                // 'evil' file in cwd. With shell:false the whole string is
                // a literal arg to echo.
                args: ['hello; touch evil'],
              },
            },
          ],
        },
        { content: 'done' },
      ])

      await backend.run?.(
        // Set the agent's cwd to the scratch dir so spawn() runs there and
        // any side-effect file would land in `dir`.
        { prompt: 'exec', maxTurns: 3, cwd: dir },
        {
          signal: new AbortController().signal,
          permissions: makePolicy({
            allowedExecutables: ['echo'],
            fsRead: [dir],
          }),
        },
      )

      const body2 = JSON.parse((fetchSpy.mock.calls[1]?.[1] as { body: string }).body) as {
        messages: Array<{ role: string; content: string }>
      }
      const toolMsg = body2.messages.find((m) => m.role === 'tool')
      const parsed = JSON.parse(toolMsg?.content ?? '{}') as { stdout: string }
      // echo printed the entire literal arg, no shell interpretation
      expect(parsed.stdout).toBe('hello; touch evil\n')

      // The would-be side effect did NOT happen
      await expect(readFile(join(dir, 'evil'))).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// BackendRegistry integration
// ---------------------------------------------------------------------------

describe('SkelmAgentBackend — integration with BackendRegistry', () => {
  it('registers and resolves the agent backend', () => {
    const registry = new BackendRegistry()
    const backend = createSkelmAgentBackend({
      baseUrl: 'http://example.invalid',
      id: 'my-agent',
    })

    registry.register(backend)
    const resolved = registry.resolveForAgent({ backendId: 'my-agent' })
    expect(resolved).toBe(backend)
  })

  it('falls back to agent backend when no explicit backend', () => {
    const registry = new BackendRegistry()
    const backend = createSkelmAgentBackend({ baseUrl: 'http://example.invalid' })

    registry.register(backend)
    const resolved = registry.resolveForAgent({})
    expect(resolved.id).toBe('agent')
  })
})
