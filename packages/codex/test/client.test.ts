import type { ThreadEvent } from '@openai/codex-sdk'
import { describe, expect, it, vi } from 'vitest'
import { buildCodexOptions, buildMcpServerConfig, consumeStream } from '../src/client.js'

describe('buildCodexOptions', () => {
  it('passes through codexPathOverride, baseUrl, apiKey when set', () => {
    const opts = buildCodexOptions({
      codexPathOverride: '/usr/local/bin/codex',
      baseUrl: 'https://api.codex.test',
      apiKey: 'sk-test',
    })
    expect(opts.codexPathOverride).toBe('/usr/local/bin/codex')
    expect(opts.baseUrl).toBe('https://api.codex.test')
    expect(opts.apiKey).toBe('sk-test')
    expect(opts.env).toBeUndefined()
  })

  it('merges proxyEnv with passthrough env vars', () => {
    const old = { ...process.env }
    process.env.CODEX_API_KEY = 'sk-from-env'
    try {
      const opts = buildCodexOptions(
        {},
        { env: { HTTP_PROXY: 'http://127.0.0.1:14739', SKELM_EGRESS_TOKEN: 'tok' } },
      )
      expect(opts.env?.HTTP_PROXY).toBe('http://127.0.0.1:14739')
      expect(opts.env?.SKELM_EGRESS_TOKEN).toBe('tok')
      expect(opts.env?.CODEX_API_KEY).toBe('sk-from-env')
      // PATH should always be carried so the SDK can find the codex CLI.
      expect(opts.env?.PATH).toBeTypeOf('string')
    } finally {
      process.env = old
    }
  })

  it('does NOT inherit process.env when options.env is explicitly pinned', () => {
    const opts = buildCodexOptions({ env: { FOO: 'bar' } }, { env: { BAZ: 'qux' } })
    expect(opts.env).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('forwards a config override unchanged', () => {
    const opts = buildCodexOptions({}, { config: { mcp_servers: { srv: { command: 'x' } } } })
    expect(opts.config).toEqual({ mcp_servers: { srv: { command: 'x' } } })
  })
})

describe('buildMcpServerConfig', () => {
  it('maps a single stdio server', () => {
    const out = buildMcpServerConfig([
      { id: 'fs', transport: 'stdio', command: 'npx', args: ['-y', '@mcp/fs'] },
    ])
    expect(out).not.toBeNull()
    expect(out?.mcp_servers.fs).toEqual({ command: 'npx', args: ['-y', '@mcp/fs'] })
    expect(out?.dropped).toEqual([])
  })

  it('drops http/sse servers (Codex config.toml only supports stdio)', () => {
    const out = buildMcpServerConfig([
      { id: 'remote', transport: 'http', url: 'https://example.com/mcp' },
    ])
    expect(out).toBeNull()
  })

  it('mixes allowed and dropped', () => {
    const out = buildMcpServerConfig([
      { id: 'a', transport: 'stdio', command: 'a-cmd' },
      { id: 'b', transport: 'sse', url: 'https://b' },
    ])
    expect(out?.mcp_servers).toEqual({ a: { command: 'a-cmd' } })
    expect(out?.dropped).toEqual(['b'])
  })

  it('returns null for an empty input', () => {
    expect(buildMcpServerConfig([])).toBeNull()
  })
})

describe('consumeStream', () => {
  async function* scripted(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
    for (const e of events) yield e
  }

  it('captures agent_message text and forwards to onText', async () => {
    const onText = vi.fn()
    const result = await consumeStream(
      scripted([
        { type: 'thread.started', thread_id: 't-1' },
        { type: 'turn.started' },
        {
          type: 'item.completed',
          item: { id: 'i1', type: 'agent_message', text: 'hello world' },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 12,
            cached_input_tokens: 0,
            output_tokens: 8,
            reasoning_output_tokens: 0,
          },
        },
      ]),
      { onText },
    )
    expect(result.finalText).toBe('hello world')
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 8, reasoningTokens: 0 })
    expect(result.stopReason).toBe('turn.completed')
    expect(onText).toHaveBeenCalledWith('hello world')
  })

  it('emits text DELTAS to onText when Codex streams cumulative agent_message updates', async () => {
    // Codex's `agent_message.text` is cumulative; skelm's onPartial contract
    // is incremental. consumeStream must compute the suffix.
    const onText = vi.fn()
    await consumeStream(
      scripted([
        { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'hello' } },
        { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'hello world' } },
        {
          type: 'item.completed',
          item: { id: 'a', type: 'agent_message', text: 'hello world!' },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
          },
        },
      ]),
      { onText },
    )
    expect(onText.mock.calls.map((c) => c[0])).toEqual(['hello', ' world', '!'])
  })

  it("falls back to the full text when a later agent_message doesn't share the running prefix", async () => {
    // Defensive: if Codex ever emits a fully replaced message (not a strict
    // append), we should still forward the new content rather than slicing
    // off a prefix that doesn't match.
    const onText = vi.fn()
    await consumeStream(
      scripted([
        { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'foo' } },
        { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'BAR' } },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
          },
        },
      ]),
      { onText },
    )
    expect(onText.mock.calls.map((c) => c[0])).toEqual(['foo', 'BAR'])
  })

  it('throws on turn.failed and surfaces the error message', async () => {
    await expect(
      consumeStream(
        scripted([{ type: 'turn.failed', error: { message: 'context exceeded' } }]),
        {},
      ),
    ).rejects.toThrow(/codex turn failed: context exceeded/)
  })

  it('throws on stream-level error events', async () => {
    await expect(
      consumeStream(scripted([{ type: 'error', message: 'connection reset' }]), {}),
    ).rejects.toThrow(/codex stream error: connection reset/)
  })

  it('fires onItem for each completed item (command_execution, file_change, mcp_tool_call)', async () => {
    const onItem = vi.fn()
    await consumeStream(
      scripted([
        {
          type: 'item.completed',
          item: {
            id: 'c1',
            type: 'command_execution',
            command: 'ls',
            aggregated_output: 'file.txt\n',
            exit_code: 0,
            status: 'completed',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'f1',
            type: 'file_change',
            changes: [{ path: '/tmp/x', kind: 'add' }],
            status: 'completed',
          },
        },
        {
          type: 'item.completed',
          item: {
            id: 'm1',
            type: 'mcp_tool_call',
            server: 'fs',
            tool: 'read',
            arguments: { path: '/tmp/x' },
            status: 'completed',
          },
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
          },
        },
      ]),
      { onItem },
    )
    expect(onItem).toHaveBeenCalledTimes(3)
    const types = onItem.mock.calls.map((c) => c[0].item.type)
    expect(types).toEqual(['command_execution', 'file_change', 'mcp_tool_call'])
  })
})
