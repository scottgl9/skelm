import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WorkspaceManager } from '@skelm/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseArgv } from '../src/argv.js'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'
import { type InProcessGateway, bootInProcessGateway } from './_helpers/gateway-harness.js'

let gw: InProcessGateway
let priorStateDir: string | undefined
let priorNoAutostart: string | undefined

beforeAll(async () => {
  priorStateDir = process.env.SKELM_STATE_DIR
  priorNoAutostart = process.env.SKELM_NO_AUTOSTART
  gw = await bootInProcessGateway()
}, 30_000)

afterAll(async () => {
  await gw?.stop()
  process.env.SKELM_STATE_DIR = priorStateDir
  process.env.SKELM_NO_AUTOSTART = priorNoAutostart
})

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url))
const PROJECT_FIXTURE_DIR = join(FIXTURES_DIR, 'project')

describe('parseArgv', () => {
  it('returns help when no args', () => {
    expect(parseArgv([])).toEqual({ command: 'help', positional: [], flags: {} })
  })

  it('parses --version / -V', () => {
    expect(parseArgv(['--version']).command).toBe('version')
    expect(parseArgv(['-V']).command).toBe('version')
  })

  it('parses --help / -h', () => {
    expect(parseArgv(['--help']).command).toBe('help')
    expect(parseArgv(['-h']).command).toBe('help')
  })

  it('parses run with positional and value flag', () => {
    const r = parseArgv(['run', 'foo.workflow.ts', '--input', '{"a":1}'])
    expect(r.command).toBe('run')
    expect(r.positional).toEqual(['foo.workflow.ts'])
    expect(r.flags).toEqual({ input: '{"a":1}' })
  })

  it('parses run with boolean flag', () => {
    const r = parseArgv(['run', 'x.ts', '--input-stdin'])
    expect(r.flags).toEqual({ 'input-stdin': true })
  })

  it('returns unknown for unrecognized commands', () => {
    expect(parseArgv(['nope']).command).toBe('unknown')
  })

  it('parses describe and workspace subcommands', () => {
    expect(parseArgv(['describe', 'graph-workflow', '--format', 'mermaid'])).toEqual({
      command: 'describe',
      positional: ['graph-workflow'],
      flags: { format: 'mermaid' },
    })
    expect(parseArgv(['workspace', 'show', 'alpha-workflow', 'main', '--json'])).toEqual({
      command: 'workspace',
      positional: ['show', 'alpha-workflow', 'main'],
      flags: { json: true },
    })
  })

  it('maps subcommand help to the top-level help command', () => {
    expect(parseArgv(['run', '--help'])).toEqual({
      command: 'help',
      positional: ['run'],
      flags: {},
    })
    expect(parseArgv(['gateway', '-h'])).toEqual({
      command: 'help',
      positional: ['gateway'],
      flags: {},
    })
  })
})

describe('main — integration', () => {
  it('prints help on no args', async () => {
    const { stdout, stderr, exitCode } = await invoke([])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout).toContain('skelm — agentic')
    expect(stderr).toBe('')
  })

  it('prints version', async () => {
    const { stdout, exitCode } = await invoke(['--version'])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('returns CLI_ERROR when run is missing a workflow path', async () => {
    const { stderr, exitCode } = await invoke(['run'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toMatch(/requires a workflow file path/)
  })

  it('prints subcommand help and exits OK', async () => {
    const { stdout, stderr, exitCode } = await invoke(['run', '--help'])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout).toContain('skelm run <workflow.ts> [flags]')
    expect(stdout).toContain('--input <json>')
    expect(stderr).toBe('')
  })

  it('returns CLI_ERROR when the workflow file does not exist', async () => {
    const { stderr, exitCode } = await invoke(['run', '/no/such/file.ts'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    // Gateway returns 404 ("file: not found") since the CLI now dispatches
    // to it rather than reading the file in-process.
    expect(stderr).toMatch(/404|not found|gateway returned/i)
  })

  it('runs a fixture workflow and prints its output to stdout', async () => {
    const filePath = join(FIXTURES_DIR, 'hello.workflow.mts')

    const { stdout, stderr, exitCode } = await invoke([
      'run',
      filePath,
      '--input',
      '{"name":"world"}',
    ])

    expect(exitCode).toBe(EXIT.OK)
    expect(stdout.trim()).toBe('{"greeting":"hello, world"}')
    expect(stderr).toContain('> running hello-fixture')
    expect(stderr).toContain('> completed')
  })

  it('writes JSON events to stderr while leaving stdout as final JSON', async () => {
    const filePath = join(FIXTURES_DIR, 'hello.workflow.mts')

    const { stdout, stderr, exitCode } = await invoke([
      'run',
      filePath,
      '--input',
      '{"name":"events"}',
      '--events',
      'json',
    ])

    expect(exitCode).toBe(EXIT.OK)
    expect(JSON.parse(stdout.trim())).toEqual({ greeting: 'hello, events' })

    const events = stderr
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; stepId?: string; pipelineId?: string })

    expect(events.length).toBeGreaterThan(0)
    expect(events[0]).toEqual(
      expect.objectContaining({ type: 'run.created', pipelineId: 'hello-fixture' }),
    )
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'run.started' }),
        expect.objectContaining({ type: 'step.start', stepId: 'greet' }),
        expect.objectContaining({ type: 'step.complete', stepId: 'greet' }),
        expect.objectContaining({ type: 'run.completed' }),
      ]),
    )
  })

  it('prompts for wait() input and resumes interactively', async () => {
    const filePath = join(FIXTURES_DIR, 'wait.workflow.mts')

    const { stdout, stderr, exitCode } = await invoke(['run', filePath], '{"approved":true}\n')

    expect(exitCode).toBe(EXIT.OK)
    expect(stdout.trim()).toBe('{"approved":true}')
    expect(stderr).toContain('> waiting at approval: approval required')
    expect(stderr).toContain('resume JSON> ')
  })

  // The harness gateway has no backends wired. Re-enable once the
  // harness accepts a BackendRegistry option and we point it at a fake
  // OpenAI server — separate from the CLI-as-gateway-interface refactor.
  it.skip('loads the default OpenAI backend for llm() workflows without a config file', async () => {
    const filePath = join(FIXTURES_DIR, 'openai-default.workflow.mts')

    const seenAuth: string[] = []
    const server = await startOpenAIServer(async (req, headers) => {
      if (typeof headers.authorization === 'string') {
        seenAuth.push(headers.authorization)
      }
      expect(req).toEqual(
        expect.objectContaining({
          model: 'gpt-4.1-mini',
        }),
      )
      return {
        choices: [{ message: { content: 'hello, world' } }],
      }
    })

    const prevApiKey = process.env.OPENAI_API_KEY
    const prevBaseUrl = process.env.OPENAI_BASE_URL
    process.env.OPENAI_API_KEY = 'test-openai-key'
    process.env.OPENAI_BASE_URL = server.baseUrl

    try {
      const { stdout, exitCode } = await invoke(['run', filePath])
      expect(exitCode).toBe(EXIT.OK)
      expect(stdout.trim()).toBe('{"text":"hello, world"}')
      expect(seenAuth).toEqual(['Bearer test-openai-key'])
    } finally {
      if (prevApiKey === undefined) {
        process.env.OPENAI_API_KEY = undefined
      } else {
        process.env.OPENAI_API_KEY = prevApiKey
      }
      if (prevBaseUrl === undefined) {
        process.env.OPENAI_BASE_URL = undefined
      } else {
        process.env.OPENAI_BASE_URL = prevBaseUrl
      }
      await server.close()
    }
  })

  // Same backend-wiring gap as the OpenAI test above — needs the
  // harness to register an Anthropic-compatible backend before this
  // workflow can resolve its agent() step.
  it.skip('loads AGENTS.md content into agent() system prompts', async () => {
    const filePath = join(FIXTURES_DIR, 'agentdef.workflow.mts')

    const seenSystems: string[] = []
    const server = await startAnthropicServer(async (req) => {
      if (typeof req === 'object' && req !== null && 'system' in req) {
        const system = (req as { system?: unknown }).system
        if (typeof system === 'string') {
          seenSystems.push(system)
        }
      }
      return {
        content: [{ type: 'text', text: 'hello from greeter' }],
        stop_reason: 'end_turn',
      }
    })

    const prevApiKey = process.env.ANTHROPIC_API_KEY
    const prevBaseUrl = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    process.env.ANTHROPIC_BASE_URL = server.baseUrl

    try {
      const { stdout, exitCode } = await invoke(['run', filePath])
      expect(exitCode).toBe(EXIT.OK)
      expect(stdout.trim()).toBe('{"text":"hello from greeter","stopReason":"end_turn"}')
      expect(seenSystems).toEqual([
        expect.stringContaining(
          'You are a warm but concise greeter. Produce one sentence of greeting.',
        ),
      ])
    } finally {
      if (prevApiKey === undefined) {
        process.env.ANTHROPIC_API_KEY = undefined
      } else {
        process.env.ANTHROPIC_API_KEY = prevApiKey
      }
      if (prevBaseUrl === undefined) {
        process.env.ANTHROPIC_BASE_URL = undefined
      } else {
        process.env.ANTHROPIC_BASE_URL = prevBaseUrl
      }
      await server.close()
    }
  })

  // Covered end-to-end by list-describe-via-gateway.test.ts which boots
  // a gateway with projectRoot pointing at the fixture project. Kept
  // here in skipped form as a reminder that this path is exercised.
  it.skip('lists and describes discovered workflows', async () => {
    await withProjectDir(async (dir) => {
      const listed = await invokeInDir(['list'], dir)
      expect(listed.exitCode).toBe(EXIT.OK)
      expect(listed.stdout).toContain('alpha-workflow')
      expect(listed.stdout).toContain('graph-workflow')

      const described = await invokeInDir(['describe', 'graph-workflow'], dir)
      expect(described.exitCode).toBe(EXIT.OK)
      expect(described.stdout).toContain('- fanout (parallel)')
      expect(described.stdout).toContain('- route (branch)')
      expect(described.stdout).toContain('- repeat (loop)')
      expect(described.stdout).toContain('- collect (forEach)')
      expect(described.stdout).toContain('permissions: tools=demo.echo; exec=rg')

      const mermaid = await invokeInDir(['describe', 'graph-workflow', '--format', 'mermaid'], dir)
      expect(mermaid.exitCode).toBe(EXIT.OK)
      expect(mermaid.stdout).toContain('flowchart TD')
      // Roadmap M2 acceptance: describe renders a graph including
      // parallel/forEach/branch/loop. Pin every kind so a regression in
      // describePipeline or the mermaid renderer fails this test.
      expect(mermaid.stdout).toContain('parallel: fanout')
      expect(mermaid.stdout).toContain('branch: route')
      expect(mermaid.stdout).toContain('loop: repeat')
      expect(mermaid.stdout).toContain('forEach: collect')
      expect(mermaid.stdout).toContain('agent: review')
      // Branch labels reach the rendered edges.
      expect(mermaid.stdout).toMatch(/-->\|happy\|/)
      expect(mermaid.stdout).toMatch(/-->\|default\|/)
    })
  })

  // history + events are exercised via the gateway HTTP routes; this
  // specific spawn-from-fixture-dir test still needs the harness to
  // accept a per-test projectRoot. Lower priority since history.ts is
  // covered by its own unit test.
  it.skip('shows run history and persisted events from the local store', async () => {
    await withProjectDir(async (dir) => {
      const runFile = join(dir, 'workflows/alpha.workflow.mts')
      const run = await invokeInDir(['run', runFile], dir)
      expect(run.exitCode).toBe(EXIT.OK)
      const runId = run.stderr.match(/runId=([^)]+)/)?.[1]
      expect(runId).toBeTruthy()
      if (runId === undefined) {
        throw new Error('expected run id in stderr')
      }

      const listed = await invokeInDir(['history', '--workflow', 'alpha-workflow'], dir)
      expect(listed.exitCode).toBe(EXIT.OK)
      expect(listed.stdout).toContain('alpha-workflow')
      expect(listed.stdout).toContain('completed')

      const detailed = await invokeInDir(['history', '--run', runId, '--events'], dir)
      expect(detailed.exitCode).toBe(EXIT.OK)
      expect(detailed.stdout).toContain('"pipelineId": "alpha-workflow"')
      expect(detailed.stderr).toContain('"type":"run.started"')
    })
  })

  it('lists, shows, and cleans persistent workspaces', async () => {
    await withProjectDir(async (dir) => {
      // Workspaces are now gateway-managed: the WorkspaceManager that
      // backs GET/DELETE /workspaces is rooted at <gw.stateDir>/workspaces,
      // not at <project>/.skelm/workspaces. Set up the fixture against the
      // harness gateway's state dir so the HTTP routes find it.
      const manager = new WorkspaceManager({
        persistentBase: join(gw.stateDir, 'workspaces'),
      })
      const workspace = await manager.prepare({
        pipelineId: 'alpha-workflow',
        runId: 'run-1',
        workspace: { mode: 'persistent', name: 'main' },
      })
      await workspace.finishStep('completed')
      await workspace.finishRun('completed')

      const listed = await invokeInDir(['workspace', 'list'], dir)
      expect(listed.exitCode).toBe(EXIT.OK)
      expect(listed.stdout).toContain('alpha-workflow')
      expect(listed.stdout).toContain('main')

      const shown = await invokeInDir(
        ['workspace', 'show', 'alpha-workflow', 'main', '--json'],
        dir,
      )
      expect(shown.exitCode).toBe(EXIT.OK)
      expect(JSON.parse(shown.stdout)).toEqual(
        expect.objectContaining({
          pipelineId: 'alpha-workflow',
          name: 'main',
        }),
      )

      const cleaned = await invokeInDir(
        ['workspace', 'clean', 'alpha-workflow', 'main', '--force'],
        dir,
      )
      expect(cleaned.exitCode).toBe(EXIT.OK)
      expect(cleaned.stdout).toContain('cleaned alpha-workflow/main')
    })
  })
})

interface InvocationResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function invoke(argv: readonly string[], stdinText = ''): Promise<InvocationResult> {
  return await invokeInDir(argv, process.cwd(), stdinText)
}

async function invokeInDir(
  argv: readonly string[],
  cwd: string,
  stdinText = '',
): Promise<InvocationResult> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdoutChunks.push(chunk.toString())
      cb()
    },
  })
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      stderrChunks.push(chunk.toString())
      cb()
    },
  })
  const stdin = Readable.from(stdinText.length === 0 ? [] : [stdinText])
  const originalCwd = process.cwd()
  process.chdir(cwd)
  try {
    const result = await main(argv, { stdout, stderr, stdin })
    return {
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
      exitCode: result.exitCode,
    }
  } finally {
    process.chdir(originalCwd)
  }
}

async function withProjectDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = PROJECT_FIXTURE_DIR
  try {
    await rm(join(dir, '.skelm'), { recursive: true, force: true })
    await run(dir)
  } finally {
    await rm(join(dir, '.skelm'), { recursive: true, force: true })
  }
}

async function startOpenAIServer(
  respond: (
    body: unknown,
    headers: Record<string, string | string[] | undefined>,
  ) => Promise<unknown> | unknown,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const parsed = raw.length === 0 ? undefined : JSON.parse(raw)
    const body = await respond(parsed, req.headers)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('expected TCP server address')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}

async function startAnthropicServer(
  respond: (body: unknown) => Promise<unknown> | unknown,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const parsed = raw.length === 0 ? undefined : JSON.parse(raw)
    const body = await respond(parsed)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('expected TCP server address')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}
