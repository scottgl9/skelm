/**
 * Run-path tests with `@openai/codex-sdk` mocked.
 *
 * Verifies that backend.run() honors the skelm-feature matrix:
 *   - MCP server injection respects policy.allowedMcpServers
 *   - Skills load via context.loadSkill (policy-enforced)
 *   - Egress proxy env is passed through to Codex
 *   - Workspace pinning maps to ThreadOptions.workingDirectory
 *   - Streaming agent_message text flows to context.onPartial
 *   - Resumption: request.sessionId triggers resumeThread, not startThread
 *   - Refusal: fsWrite ["*"] with an approval policy throws
 */

import type { ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import {
  type AgentPermissions,
  type AgentRequest,
  BackendCapabilityError,
  type BackendContext,
  BackendUnavailableError,
  resolvePermissions,
} from '@skelm/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the SDK BEFORE importing the backend.
const startThread = vi.fn()
const resumeThread = vi.fn()
const codexCtor = vi.fn()

vi.mock('@openai/codex-sdk', async () => {
  return {
    Codex: class MockCodex {
      constructor(opts: unknown) {
        codexCtor(opts)
      }
      startThread(threadOpts: unknown) {
        return startThread(threadOpts)
      }
      resumeThread(id: string, threadOpts: unknown) {
        return resumeThread(id, threadOpts)
      }
    },
  }
})

const { createCodexBackend } = await import('../src/backend.js')

function makeThread(events: ThreadEvent[]): unknown {
  async function* gen() {
    for (const e of events) yield e
  }
  return {
    id: 't-mock',
    runStreamed: vi.fn(async () => ({ events: gen() })),
    run: vi.fn(),
  }
}

function makeContext(overrides: Partial<BackendContext> = {}): BackendContext {
  return {
    signal: new AbortController().signal,
    ...overrides,
  }
}

function policy(perms: AgentPermissions) {
  return resolvePermissions(undefined, perms)
}

describe('createCodexBackend.run', () => {
  beforeEach(() => {
    startThread.mockReset()
    resumeThread.mockReset()
    codexCtor.mockReset()
  })

  const okStream = (): ThreadEvent[] => [
    { type: 'thread.started', thread_id: 't-mock' },
    {
      type: 'item.completed',
      item: { id: 'a1', type: 'agent_message', text: 'ok' },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    },
  ]

  it('runs a basic prompt and returns final text + usage', async () => {
    startThread.mockReturnValue(makeThread(okStream()))
    const backend = createCodexBackend()
    const res = await backend.run?.(
      { prompt: 'say ok', permissions: policy({ fsWrite: [], fsRead: [] }) } as AgentRequest,
      makeContext(),
    )
    expect(res.text).toBe('ok')
    expect(res.usage).toEqual({ inputTokens: 1, outputTokens: 1, reasoningTokens: 0 })
    expect(res.stopReason).toBe('turn.completed')
  })

  it('maps a missing codex CLI failure to BackendUnavailableError', async () => {
    startThread.mockImplementation(() => {
      throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })
    })
    const backend = createCodexBackend({ id: 'codex-local' })
    await expect(
      backend.run?.(
        { prompt: 'say ok', permissions: policy({ fsWrite: [], fsRead: [] }) } as AgentRequest,
        makeContext(),
      ),
    ).rejects.toBeInstanceOf(BackendUnavailableError)
  })

  it('refuses author-declared exact executable allowlists', async () => {
    const backend = createCodexBackend({ id: 'codex-local' })
    await expect(
      backend.run?.(
        {
          prompt: 'say ok',
          permissions: policy({ allowedExecutables: ['git'] }),
        } as AgentRequest,
        makeContext({ declaredPermissions: { allowedExecutables: ['git'] } }),
      ),
    ).rejects.toBeInstanceOf(BackendCapabilityError)
    expect(startThread).not.toHaveBeenCalled()
  })

  it('streams agent_message text to context.onPartial', async () => {
    startThread.mockReturnValue(makeThread(okStream()))
    const onPartial = vi.fn()
    const backend = createCodexBackend()
    await backend.run?.(
      { prompt: 'hi', permissions: policy({ fsWrite: [] }) } as AgentRequest,
      makeContext({ onPartial }),
    )
    expect(onPartial).toHaveBeenCalledWith('ok')
  })

  it('maps fsWrite: [] to sandboxMode: read-only and forwards via ThreadOptions', async () => {
    startThread.mockReturnValue(makeThread(okStream()))
    await createCodexBackend().run?.(
      { prompt: '.', permissions: policy({ fsWrite: [], fsRead: [] }) } as AgentRequest,
      makeContext(),
    )
    const threadOpts = startThread.mock.calls[0]?.[0] as ThreadOptions
    expect(threadOpts.sandboxMode).toBe('read-only')
    expect(threadOpts.networkAccessEnabled).toBe(false)
  })

  it('pins workingDirectory to request.cwd when provided', async () => {
    startThread.mockReturnValue(makeThread(okStream()))
    await createCodexBackend().run?.(
      {
        prompt: '.',
        cwd: '/tmp/ws/abc',
        permissions: policy({ fsWrite: ['/tmp/ws/abc'] }),
      } as AgentRequest,
      makeContext(),
    )
    const threadOpts = startThread.mock.calls[0]?.[0] as ThreadOptions
    expect(threadOpts.workingDirectory).toBe('/tmp/ws/abc')
    expect(threadOpts.sandboxMode).toBe('workspace-write')
  })

  it('injects ONLY allowed MCP servers into config.mcp_servers', async () => {
    startThread.mockReturnValue(makeThread(okStream()))
    await createCodexBackend().run?.(
      {
        prompt: '.',
        permissions: policy({ fsWrite: [], allowedMcpServers: ['srvA'] }),
        mcpServers: [
          { id: 'srvA', transport: 'stdio', command: 'a-cmd' },
          { id: 'srvB', transport: 'stdio', command: 'b-cmd' },
        ],
      } as AgentRequest,
      makeContext(),
    )
    const ctorArgs = codexCtor.mock.calls[0]?.[0] as {
      config?: Record<string, unknown>
    }
    expect(Object.keys((ctorArgs.config?.mcp_servers as object) ?? {})).toEqual(['srvA'])
    // The `dropped` bookkeeping field MUST NOT leak into Codex's config.
    expect(ctorArgs.config).not.toHaveProperty('dropped')
    expect(Object.keys(ctorArgs.config ?? {})).toEqual(['mcp_servers'])
  })

  it('drops HTTP/SSE MCP servers from the Codex config', async () => {
    startThread.mockReturnValue(makeThread(okStream()))
    await createCodexBackend().run?.(
      {
        prompt: '.',
        permissions: policy({ fsWrite: [], allowedMcpServers: ['stdio-ok', 'remote'] }),
        mcpServers: [
          { id: 'stdio-ok', transport: 'stdio', command: 'a-cmd' },
          { id: 'remote', transport: 'http', url: 'https://example.com/mcp' },
        ],
      } as AgentRequest,
      makeContext(),
    )
    const ctorArgs = codexCtor.mock.calls[0]?.[0] as {
      config?: Record<string, unknown>
    }
    // Only the stdio server should reach Codex.
    expect(Object.keys((ctorArgs.config?.mcp_servers as object) ?? {})).toEqual(['stdio-ok'])
  })

  it('forwards BackendContext.proxyEnv into the spawned codex env', async () => {
    startThread.mockReturnValue(makeThread(okStream()))
    await createCodexBackend().run?.(
      { prompt: '.', permissions: policy({ fsWrite: [] }) } as AgentRequest,
      makeContext({
        proxyEnv: { HTTP_PROXY: 'http://127.0.0.1:14739', SKELM_EGRESS_TOKEN: 't' },
      }),
    )
    const ctorArgs = codexCtor.mock.calls[0]?.[0] as { env?: Record<string, string> }
    expect(ctorArgs.env?.HTTP_PROXY).toBe('http://127.0.0.1:14739')
    expect(ctorArgs.env?.SKELM_EGRESS_TOKEN).toBe('t')
  })

  it('loads allowed skills via context.loadSkill and concatenates them into the prompt', async () => {
    startThread.mockReturnValue(makeThread(okStream()))
    const loadSkill = vi.fn(async (id: string) => {
      if (id === 'fs.read')
        return {
          id,
          description: 'fs read skill',
          body: 'SKILL_BODY_FS_READ',
          metadata: {},
          source: `/skills/${id}.md`,
        }
      return null
    })
    await createCodexBackend().run?.(
      {
        prompt: 'do the thing',
        skills: ['fs.read', 'denied-skill'],
        permissions: policy({ fsWrite: [], allowedSkills: ['fs.read'] }),
      } as AgentRequest,
      makeContext({ loadSkill }),
    )
    // The loadSkill mock was called; denied-skill loadSkill would return
    // null via the policy enforcement (we test allowed flow here).
    const userPrompt = startThread.mock.results[0]?.value.runStreamed.mock.calls[0]?.[0] as string
    expect(userPrompt).toContain('SKILL_BODY_FS_READ')
    expect(userPrompt).toContain('do the thing')
  })

  it('uses resumeThread when request.sessionId is set', async () => {
    resumeThread.mockReturnValue(makeThread(okStream()))
    await createCodexBackend().run?.(
      {
        prompt: 'continue',
        permissions: policy({ fsWrite: [] }),
        // sessionId is structurally typed on AgentRequest
        sessionId: 't-prev',
      } as unknown as AgentRequest,
      makeContext(),
    )
    expect(resumeThread).toHaveBeenCalledWith('t-prev', expect.any(Object))
    expect(startThread).not.toHaveBeenCalled()
  })

  it('refuses fsWrite: ["*"] when approval policy is set', async () => {
    const backend = createCodexBackend()
    await expect(
      backend.run?.(
        {
          prompt: '.',
          permissions: policy({ fsWrite: ['*'], approval: { on: ['executable'] } }),
        } as AgentRequest,
        makeContext(),
      ),
    ).rejects.toThrow(/danger-full-access/)
  })

  it("respects systemPromptMode='replace' (F024)", async () => {
    // Regression: the codex backend used to hand-roll the prompt out of
    // soul + instructions + system + skills, ignoring systemPromptMode.
    // The shared @skelm/core builder now drives composition.
    startThread.mockReturnValue(makeThread(okStream()))
    const sharedAgentDef = {
      name: 'demo',
      instructions: 'AGENTDEF_MARKER instructions',
    }
    const back = createCodexBackend()

    // 1. extend (default): user 'system' string is appended; builder also
    //    includes its default block, so prompt length is > user system alone.
    await back.run?.(
      {
        prompt: 'do',
        system: 'USER_SYS_MARKER',
        agentDef: sharedAgentDef,
        permissions: policy({}),
      } as AgentRequest,
      makeContext(),
    )
    const extended = startThread.mock.results[0]?.value.runStreamed.mock.calls[0]?.[0] as string
    expect(extended).toContain('USER_SYS_MARKER')
    expect(extended).toContain('AGENTDEF_MARKER')

    // 2. replace + includeAgentDef=false → built-in default AND agentDef
    //    are dropped; only the user system string remains in the system
    //    section. Final prompt to runStreamed is `<system>\n---\n<user>`.
    startThread.mockReset()
    startThread.mockReturnValue(makeThread(okStream()))
    await back.run?.(
      {
        prompt: 'do',
        system: 'USER_SYS_MARKER',
        agentDef: sharedAgentDef,
        systemPromptMode: 'replace',
        systemPromptIncludeAgentDef: false,
        permissions: policy({}),
      } as AgentRequest,
      makeContext(),
    )
    const replaced = startThread.mock.results[0]?.value.runStreamed.mock.calls[0]?.[0] as string
    expect(replaced).toContain('USER_SYS_MARKER')
    expect(replaced).not.toContain('AGENTDEF_MARKER')
    // The replace-mode prompt should be strictly shorter than the extend-mode
    // one (no default block, no agentDef).
    expect(replaced.length).toBeLessThan(extended.length)
  })

  it('synthesizes a default-deny policy when none is supplied (F021)', async () => {
    // Previously this path threw "codex backend requires a resolved
    // permission policy". The new contract is default-deny: an omitted
    // policy must produce the same Codex options as an explicit empty
    // allowlist set, never crash the run.
    startThread.mockReturnValue(makeThread(okStream()))
    const backend = createCodexBackend()
    const res = await backend.run?.({ prompt: 'hi' } as AgentRequest, makeContext())
    expect(res?.text).toBe('ok')
    // Empty fsWrite + no approval → Codex's strictest read-only sandbox.
    const opts = startThread.mock.calls[0]?.[0] as ThreadOptions
    expect(opts.sandboxMode).toBe('read-only')
    // No networkEgress => deny → networkAccessEnabled false.
    expect(opts.networkAccessEnabled).toBe(false)
  })

  it('honors options.timeoutMs via the SDK TurnOptions.signal', async () => {
    // Capture the signal the backend passes to runStreamed and verify the
    // timeout aborts it.
    let captured: AbortSignal | undefined
    startThread.mockReturnValue({
      id: 't-timeout',
      runStreamed: vi.fn(async (_input: string, opts: { signal?: AbortSignal }) => {
        captured = opts.signal
        // Never resolve — let the test drive the abort.
        async function* gen() {
          await new Promise((resolve) => {
            captured?.addEventListener('abort', () => resolve(undefined), { once: true })
          })
          return
        }
        return { events: gen() }
      }),
    })

    vi.useFakeTimers()
    try {
      const backend = createCodexBackend({ timeoutMs: 50 })
      const runPromise = backend.run?.(
        { prompt: '.', permissions: policy({ fsWrite: [] }) } as AgentRequest,
        makeContext(),
      )
      // Allow microtasks to schedule, then advance past the timeout.
      await vi.advanceTimersByTimeAsync(60)
      await runPromise
      expect(captured?.aborted).toBe(true)
      expect((captured?.reason as Error | undefined)?.message ?? '').toMatch(/timed out/)
    } finally {
      vi.useRealTimers()
    }
  })
})
