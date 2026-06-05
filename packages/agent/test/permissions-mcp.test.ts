import { BackendRegistry } from '@skelm/core/backend'
import { resolvePermissions } from '@skelm/core/permissions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSkelmAgentBackend } from '../src/index.js'

// Covers the MCP-tool dispatch enforcement branch inside the native
// agent loop: TrustEnforcer.canCallTool() must be consulted before
// the MCP host is invoked, and the denial result must flow back to
// the model as a tool-role message (not raised as an exception).

function chatResponse(turn: {
  content?: string
  toolCalls?: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>
}): unknown {
  return {
    id: 'c1',
    object: 'chat.completion',
    model: 'm',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: turn.content ?? '',
          ...(turn.toolCalls && {
            tool_calls: turn.toolCalls.map((tc, i) => ({
              id: `tool_${i}`,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          }),
        },
        finish_reason: turn.toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function stubFetch(
  turns: ReadonlyArray<Parameters<typeof chatResponse>[0]>,
): ReturnType<typeof vi.fn> {
  const queue = [...turns]
  const spy = vi.fn(async () => {
    const next = queue.shift() ?? turns[turns.length - 1]
    return new Response(JSON.stringify(chatResponse(next ?? { content: '' })), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

function policy(overrides: Parameters<typeof resolvePermissions>[0] = {}) {
  return resolvePermissions(
    {
      allowedTools: ['echo.greet'],
      allowedExecutables: [],
      allowedSkills: [],
      allowedMcpServers: ['echo'],
      allowedSecrets: [],
      fsRead: [process.cwd()],
      fsWrite: [process.cwd()],
      networkEgress: 'deny',
      ...overrides,
    },
    undefined,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SkelmAgentBackend — MCP tool permission enforcement', () => {
  const backend = createSkelmAgentBackend({
    baseUrl: 'http://example.invalid',
    model: 'mock-model',
  })

  it('blocks an MCP tool call when allowedTools omits it and surfaces the denial to the model', async () => {
    const invokeTool = vi.fn()
    const mcpHost = {
      listTools: async () => [
        {
          id: 'echo.greet',
          serverId: 'echo',
          name: 'greet',
          description: '',
          inputSchema: { type: 'object' },
        },
        {
          id: 'echo.shout',
          serverId: 'echo',
          name: 'shout',
          description: '',
          inputSchema: { type: 'object' },
        },
      ],
      invokeTool,
      dispose: async () => {},
    }
    const fetchSpy = stubFetch([
      { toolCalls: [{ name: 'echo.shout', arguments: { who: 'world' } }] },
      { content: 'blocked' },
    ])
    const publish = vi.fn()

    const response = await backend.run?.(
      { prompt: 'shout', maxTurns: 3 },
      {
        signal: new AbortController().signal,
        permissions: policy({ allowedTools: ['echo.greet'] }),
        mcpHost,
        events: { publish },
        runId: 'run-mcp-denied',
        stepId: 'step-mcp-denied',
      },
    )

    expect(response?.text).toBe('blocked')
    expect(invokeTool).not.toHaveBeenCalled()

    // The tool-role message routed back to the model on turn 2 must
    // carry the structured denial reason, not the upstream MCP error.
    const body2 = JSON.parse((fetchSpy.mock.calls[1]?.[1] as { body: string }).body) as {
      messages: Array<{ role: string; content: string }>
    }
    const toolMsg = body2.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toMatch(/Permission denied: not-in-allowlist/)
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'permission.denied',
        runId: 'run-mcp-denied',
        stepId: 'step-mcp-denied',
        dimension: 'tool',
      }),
    )
  })

  it('honors deniedTools as a hard override even when allowedTools includes the id', async () => {
    const invokeTool = vi.fn()
    const mcpHost = {
      listTools: async () => [
        {
          id: 'echo.greet',
          serverId: 'echo',
          name: 'greet',
          description: '',
          inputSchema: { type: 'object' },
        },
      ],
      invokeTool,
      dispose: async () => {},
    }
    const fetchSpy = stubFetch([
      { toolCalls: [{ name: 'echo.greet', arguments: { who: 'x' } }] },
      { content: 'denylist won' },
    ])

    await backend.run?.(
      { prompt: 'greet', maxTurns: 3 },
      {
        signal: new AbortController().signal,
        permissions: policy({
          allowedTools: ['echo.greet'],
          deniedTools: ['echo.greet'],
        }),
        mcpHost,
      },
    )

    expect(invokeTool).not.toHaveBeenCalled()
    const body2 = JSON.parse((fetchSpy.mock.calls[1]?.[1] as { body: string }).body) as {
      messages: Array<{ role: string; content: string }>
    }
    const toolMsg = body2.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toMatch(/Permission denied: in-denylist/)
  })

  it('surfaces an "Unknown tool" message when no MCP host is wired and the model calls a non-builtin', async () => {
    stubFetch([{ toolCalls: [{ name: 'echo.nope', arguments: {} }] }, { content: 'gave up' }])
    const response = await backend.run?.(
      { prompt: 'try', maxTurns: 3 },
      { signal: new AbortController().signal, permissions: policy() },
    )
    expect(response?.text).toBe('gave up')
  })

  it('registers with BackendRegistry without throwing (smoke for static enforcement metadata)', () => {
    const reg = new BackendRegistry()
    expect(() => reg.register(backend)).not.toThrow()
  })
})
