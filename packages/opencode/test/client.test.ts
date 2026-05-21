/**
 * Tests for OpencodeClientWrapper — covers the three SDK improvements:
 *   #1 — spawn injects OPENCODE_CONFIG_CONTENT
 *   #2 — model/logLevel end up in OPENCODE_CONFIG_CONTENT
 *   #3 — promptAsync + SSE: text accumulation, session.idle termination,
 *         session.error rejection, abort signal, timeout
 *
 * Mocks child_process.spawn and @opencode-ai/sdk so no real process is needed.
 */

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── spawn mock ─────────────────────────────────────────────────────────────

let spawnEnv: Record<string, string> = {}

vi.mock('node:child_process', () => {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
    stdin: null
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()

  return {
    spawn: vi.fn((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
      spawnEnv = opts.env
      // Emit the listening URL synchronously on next tick
      queueMicrotask(() => {
        proc.stdout.emit(
          'data',
          Buffer.from('opencode server listening on http://127.0.0.1:9999\n'),
        )
      })
      return proc
    }),
    // Stubbed because @skelm/core's workspace.ts imports execFile at module
    // load; the wrapper itself doesn't call it. Never invoked in this suite.
    execFile: vi.fn(),
  }
})

// ─── SDK mock ────────────────────────────────────────────────────────────────

let mockSubscribeStream: AsyncGenerator<unknown>
let lastPromptAsyncBody: unknown
let lastSessionCreateQuery: unknown
const mcpAddCalls: Array<{ body: unknown }> = []
const permissionResponses: Array<{ permissionID: string; response: string }> = []

function makeSseStream(events: unknown[]): AsyncGenerator<unknown> {
  return (async function* () {
    for (const e of events) {
      yield e
    }
  })()
}

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: vi.fn(() => ({
    session: {
      create: vi.fn(({ query }: { query: unknown }) => {
        lastSessionCreateQuery = query
        return Promise.resolve({ data: { id: 'sess-123' }, error: null })
      }),
      promptAsync: vi.fn((opts: unknown) => {
        lastPromptAsyncBody = opts
        return Promise.resolve({ data: { id: 'sess-123' }, error: null })
      }),
      abort: vi.fn(() => Promise.resolve({ data: null, error: null })),
    },
    event: {
      subscribe: vi.fn(() => Promise.resolve({ stream: mockSubscribeStream })),
    },
    mcp: {
      add: vi.fn((opts: { body: unknown }) => {
        mcpAddCalls.push({ body: opts.body })
        return Promise.resolve({ data: {}, error: undefined })
      }),
    },
    postSessionIdPermissionsPermissionId: vi.fn(
      (opts: { path: { id: string; permissionID: string }; body: { response: string } }) => {
        permissionResponses.push({
          permissionID: opts.path.permissionID,
          response: opts.body.response,
        })
        return Promise.resolve({ data: true, error: undefined })
      },
    ),
  })),
}))

import { OpencodeClientWrapper } from '../src/client.js'

function makeSignal(aborted = false): AbortSignal {
  return aborted ? AbortSignal.abort() : new AbortController().signal
}

const ASSISTANT_MSG_ID = 'msg-assistant-1'

function assistantMessageEvent(sessionID: string) {
  return {
    type: 'message.updated',
    properties: { info: { id: ASSISTANT_MSG_ID, sessionID, role: 'assistant' } },
  }
}

function textPartEvent(sessionID: string, id: string, text: string) {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        type: 'text',
        sessionID,
        messageID: ASSISTANT_MSG_ID,
        id,
        text,
        synthetic: false,
      },
    },
  }
}

function idleEvent(sessionID: string) {
  return { type: 'session.idle', properties: { sessionID } }
}

function errorEvent(sessionID: string, error: unknown) {
  return { type: 'session.error', properties: { sessionID, error } }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OpencodeClientWrapper — OPENCODE_CONFIG_CONTENT (#1 + #2)', () => {
  beforeEach(() => {
    spawnEnv = {}
    mockSubscribeStream = makeSseStream([idleEvent('sess-123')])
  })

  it('sets OPENCODE_CONFIG_CONTENT in the spawn env', async () => {
    await new OpencodeClientWrapper({}).prompt({ prompt: 'hi' }, makeSignal())
    expect(spawnEnv.OPENCODE_CONFIG_CONTENT).toBeDefined()
  })

  it('injects model into OPENCODE_CONFIG_CONTENT', async () => {
    await new OpencodeClientWrapper({ model: 'llamacpp/qwen36' }).prompt(
      { prompt: 'hi' },
      makeSignal(),
    )
    const cfg = JSON.parse(spawnEnv.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(cfg.model).toBe('llamacpp/qwen36')
  })

  it('injects logLevel (uppercased) into OPENCODE_CONFIG_CONTENT', async () => {
    await new OpencodeClientWrapper({ logLevel: 'debug' }).prompt({ prompt: 'hi' }, makeSignal())
    const cfg = JSON.parse(spawnEnv.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(cfg.logLevel).toBe('DEBUG')
  })

  it('OPENCODE_CONFIG_CONTENT is empty object when no model or logLevel', async () => {
    await new OpencodeClientWrapper({}).prompt({ prompt: 'hi' }, makeSignal())
    const cfg = JSON.parse(spawnEnv.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(cfg.model).toBeUndefined()
    expect(cfg.logLevel).toBeUndefined()
  })
})

describe('OpencodeClientWrapper — SSE streaming (#3)', () => {
  afterEach(() => vi.clearAllMocks())

  it('accumulates text from message.part.updated events', async () => {
    mockSubscribeStream = makeSseStream([
      assistantMessageEvent('sess-123'),
      textPartEvent('sess-123', 'p1', 'Hello '),
      textPartEvent('sess-123', 'p2', 'world'),
      idleEvent('sess-123'),
    ])
    const result = await new OpencodeClientWrapper({}).prompt({ prompt: 'go' }, makeSignal())
    expect(result.text).toBe('Hello world')
  })

  it('tracks latest text per part id (incremental updates)', async () => {
    mockSubscribeStream = makeSseStream([
      assistantMessageEvent('sess-123'),
      textPartEvent('sess-123', 'p1', 'Hello'),
      textPartEvent('sess-123', 'p1', 'Hello world'), // same part id, updated
      idleEvent('sess-123'),
    ])
    const result = await new OpencodeClientWrapper({}).prompt({ prompt: 'go' }, makeSignal())
    expect(result.text).toBe('Hello world')
  })

  it('ignores synthetic text parts', async () => {
    mockSubscribeStream = makeSseStream([
      assistantMessageEvent('sess-123'),
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            sessionID: 'sess-123',
            messageID: ASSISTANT_MSG_ID,
            id: 'p1',
            text: 'real',
            synthetic: false,
          },
        },
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'text',
            sessionID: 'sess-123',
            messageID: ASSISTANT_MSG_ID,
            id: 'p2',
            text: 'synthetic',
            synthetic: true,
          },
        },
      },
      idleEvent('sess-123'),
    ])
    const result = await new OpencodeClientWrapper({}).prompt({ prompt: 'go' }, makeSignal())
    expect(result.text).toBe('real')
  })

  it('ignores events from other sessions', async () => {
    mockSubscribeStream = makeSseStream([
      assistantMessageEvent('sess-123'),
      textPartEvent('other-sess', 'p1', 'not mine'),
      textPartEvent('sess-123', 'p2', 'mine'),
      idleEvent('sess-123'),
    ])
    const result = await new OpencodeClientWrapper({}).prompt({ prompt: 'go' }, makeSignal())
    expect(result.text).toBe('mine')
  })

  it('terminates on session.idle for the correct session', async () => {
    mockSubscribeStream = makeSseStream([
      assistantMessageEvent('sess-123'),
      textPartEvent('sess-123', 'p1', 'done'),
      idleEvent('sess-123'),
      // These would never be reached:
      textPartEvent('sess-123', 'p2', 'after idle'),
    ])
    const result = await new OpencodeClientWrapper({}).prompt({ prompt: 'go' }, makeSignal())
    expect(result.text).toBe('done')
  })

  it('rejects on session.error', async () => {
    mockSubscribeStream = makeSseStream([errorEvent('sess-123', { message: 'api failure' })])
    await expect(
      new OpencodeClientWrapper({}).prompt({ prompt: 'go' }, makeSignal()),
    ).rejects.toThrow(/session error/)
  })

  it('rejects when signal is pre-aborted', async () => {
    mockSubscribeStream = makeSseStream([idleEvent('sess-123')])
    await expect(
      new OpencodeClientWrapper({}).prompt({ prompt: 'go' }, makeSignal(true)),
    ).rejects.toThrow(/cancelled/)
  })

  it('returns stopReason end_turn', async () => {
    mockSubscribeStream = makeSseStream([
      assistantMessageEvent('sess-123'),
      textPartEvent('sess-123', 'p1', 'ok'),
      idleEvent('sess-123'),
    ])
    const result = await new OpencodeClientWrapper({}).prompt({ prompt: 'go' }, makeSignal())
    expect(result.stopReason).toBe('end_turn')
  })

  it('sends prompt text to promptAsync body parts', async () => {
    mockSubscribeStream = makeSseStream([idleEvent('sess-123')])
    await new OpencodeClientWrapper({}).prompt({ prompt: 'my question' }, makeSignal())
    // lastPromptAsyncBody captures what was sent to session.promptAsync
    const body = (lastPromptAsyncBody as { body: { parts: Array<{ type: string; text: string }> } })
      .body
    expect(body.parts).toEqual([{ type: 'text', text: 'my question' }])
  })
})

describe('OpencodeClientWrapper — MCP forwarding', () => {
  beforeEach(() => {
    mcpAddCalls.length = 0
    mockSubscribeStream = makeSseStream([idleEvent('sess-123')])
  })

  it('forwards each stdio McpServerConfig via mcp.add before promptAsync', async () => {
    const wrapper = new OpencodeClientWrapper({})
    await wrapper.prompt(
      {
        prompt: 'go',
        mcpServers: [
          { id: 'fs-mcp', transport: 'stdio', command: 'npx', args: ['-y', 'server-fs', '/tmp'] },
          { id: 'everything', transport: 'stdio', command: 'npx', args: ['-y', 'server-every'] },
        ],
      },
      makeSignal(),
    )
    expect(mcpAddCalls).toHaveLength(2)
    const names = mcpAddCalls.map((c) => (c.body as { name: string }).name).sort()
    expect(names).toEqual(['everything', 'fs-mcp'])
    const fsCall = mcpAddCalls.find((c) => (c.body as { name: string }).name === 'fs-mcp')
    expect((fsCall?.body as { config: { type: string; command: string[] } }).config).toEqual({
      type: 'local',
      command: ['npx', '-y', 'server-fs', '/tmp'],
      enabled: true,
    })
  })

  it('only calls mcp.add once per server id across reused subprocess', async () => {
    const wrapper = new OpencodeClientWrapper({})
    const servers = [
      { id: 'fs-mcp', transport: 'stdio' as const, command: 'npx', args: ['-y', 'fs'] },
    ]
    mockSubscribeStream = makeSseStream([idleEvent('sess-123')])
    await wrapper.prompt({ prompt: 'a', mcpServers: servers }, makeSignal())
    mockSubscribeStream = makeSseStream([idleEvent('sess-123')])
    await wrapper.prompt({ prompt: 'b', mcpServers: servers }, makeSignal())
    expect(mcpAddCalls).toHaveLength(1)
  })

  it('rejects non-stdio MCP transports with a clear error', async () => {
    await expect(
      new OpencodeClientWrapper({}).prompt(
        {
          prompt: 'go',
          mcpServers: [{ id: 'r', transport: 'http', url: 'https://example.test/mcp' }],
        },
        makeSignal(),
      ),
    ).rejects.toThrow(/only forwards stdio MCP servers/)
  })
})

describe('OpencodeClientWrapper — permission.asked routing', () => {
  beforeEach(() => {
    permissionResponses.length = 0
  })

  function permEvent(id: string, filepath: string) {
    return {
      type: 'permission.asked',
      properties: {
        sessionID: 'sess-123',
        id,
        permission: 'external_directory',
        patterns: [`${filepath}*`],
        metadata: { filepath },
      },
    }
  }

  const emptyPolicy = {
    allowedTools: { exact: new Set<string>(), prefixes: [] as string[], star: false },
    deniedTools: { exact: new Set<string>(), prefixes: [] as string[], star: false },
    allowedExecutables: new Set<string>(),
    allowedMcpServers: new Set<string>(),
    allowedSkills: new Set<string>(),
    allowedSecrets: new Set<string>(),
    networkEgress: 'deny' as const,
    fsRead: new Set<string>(),
    fsWrite: new Set<string>(),
    approval: null,
  }

  it('responds `once` when filepath is inside fsRead', async () => {
    mockSubscribeStream = makeSseStream([
      assistantMessageEvent('sess-123'),
      permEvent('p1', '/tmp/skelm-mcp-fs-root/hello.txt'),
      idleEvent('sess-123'),
    ])
    await new OpencodeClientWrapper({}).prompt({ prompt: 'go' }, makeSignal(), 30_000, {
      ...emptyPolicy,
      fsRead: new Set(['/tmp/skelm-mcp-fs-root']),
    })
    expect(permissionResponses).toEqual([{ permissionID: 'p1', response: 'once' }])
  })

  it('responds `reject` when filepath is outside both fsRead and fsWrite', async () => {
    mockSubscribeStream = makeSseStream([
      assistantMessageEvent('sess-123'),
      permEvent('p2', '/tmp/skelm-mcp-secret.txt'),
      idleEvent('sess-123'),
    ])
    await new OpencodeClientWrapper({}).prompt({ prompt: 'go' }, makeSignal(), 30_000, {
      ...emptyPolicy,
      fsWrite: new Set(['/tmp/skelm-mcp-fs-root']),
    })
    expect(permissionResponses).toEqual([{ permissionID: 'p2', response: 'reject' }])
  })

  it('responds `reject` when no policy is provided', async () => {
    mockSubscribeStream = makeSseStream([
      assistantMessageEvent('sess-123'),
      permEvent('p3', '/anywhere'),
      idleEvent('sess-123'),
    ])
    await new OpencodeClientWrapper({}).prompt({ prompt: 'go' }, makeSignal())
    expect(permissionResponses).toEqual([{ permissionID: 'p3', response: 'reject' }])
  })
})
