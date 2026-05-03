import { createServer } from 'node:http'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseArgv } from '../src/argv.js'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url))

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

  it('returns CLI_ERROR when the workflow file does not exist', async () => {
    const { stderr, exitCode } = await invoke(['run', '/no/such/file.ts'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toMatch(/workflow file not found/)
  })

  it('runs a fixture workflow and prints its output to stdout', async () => {
    const filePath = join(FIXTURES_DIR, 'hello.workflow.ts')

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

  it('loads the default OpenAI backend for llm() workflows without a config file', async () => {
    const filePath = join(FIXTURES_DIR, 'openai-default.workflow.ts')

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
})

interface InvocationResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function invoke(argv: readonly string[]): Promise<InvocationResult> {
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
  const stdin = Readable.from([])
  const result = await main(argv, { stdout, stderr, stdin })
  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode: result.exitCode,
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
