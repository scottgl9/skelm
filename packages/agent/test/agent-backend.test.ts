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
  content?: string
  toolCalls?: readonly ToolCallStub[]
  finishReason?: string
}

function buildChatResponse(turn: TurnStub): unknown {
  const choice: Record<string, unknown> = {
    index: 0,
    message: {
      role: 'assistant',
      content: turn.content ?? '',
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
// infer() — single-shot LLM inference
// ---------------------------------------------------------------------------

describe('SkelmAgentBackend — infer (mocked)', () => {
  const backend = createSkelmAgentBackend({
    baseUrl: 'http://example.invalid',
    model: 'mock-model',
  })

  it('returns the assistant content for a simple prompt', async () => {
    stubFetch([{ content: '4' }])

    const response = await backend.infer?.(
      { messages: [{ role: 'user', content: 'What is 2 + 2?' }] },
      { signal: new AbortController().signal },
    )

    expect(response?.text).toBe('4')
    expect(response?.usage?.inputTokens).toBe(10)
    expect(response?.usage?.outputTokens).toBe(5)
  })

  it('requests JSON object mode and parses structured output', async () => {
    const fetchSpy = stubFetch([{ content: '{"answer":"4"}' }])

    const response = await backend.infer?.(
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

    await apiKeyed.infer?.(
      { messages: [{ role: 'user', content: 'ping' }] },
      { signal: new AbortController().signal },
    )

    const headers = (fetchSpy.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers
    expect(headers.Authorization).toBe('Bearer sk-test')
  })

  it('throws when the upstream returns an empty response', async () => {
    stubFetch([{ content: '' }])

    await expect(
      backend.infer?.(
        { messages: [{ role: 'user', content: 'x' }] },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/empty response/i)
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
