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
