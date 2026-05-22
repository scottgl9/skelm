import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const EXAMPLES_DIR = join(REPO_ROOT, 'examples')

/**
 * End-to-end smoke tests against the real example workflows shipped under
 * /examples. These guard the customer-facing surface: if any of these
 * break, the readme/quickstart instructions break.
 */
describe('skelm run examples/* — smoke', () => {
  it('hello.workflow.mts greets the input name', async () => {
    const { stdout, exitCode } = await invoke([
      'run',
      join(EXAMPLES_DIR, 'hello/hello.workflow.mts'),
      '--input',
      '{"name":"world"}',
    ])
    expect(exitCode).toBe(EXIT.OK)
    expect(JSON.parse(stdout.trim())).toEqual({ greeting: 'hello, world' })
  })

  it('sum.workflow.mts sums two numbers across three code steps', async () => {
    const { stdout, exitCode } = await invoke([
      'run',
      join(EXAMPLES_DIR, 'sum/sum.workflow.mts'),
      '--input',
      '{"a":2,"b":3}',
    ])
    expect(exitCode).toBe(EXIT.OK)
    expect(JSON.parse(stdout.trim())).toEqual({ sum: 5 })
  })

  it('permissions-demo.workflow.mts denies every privileged action under default-deny', async () => {
    const { stdout, exitCode } = await invoke([
      'run',
      join(EXAMPLES_DIR, 'permissions-demo/demo.workflow.mts'),
      '--input',
      '{}',
    ])
    expect(exitCode).toBe(EXIT.OK)
    const out = JSON.parse(stdout.trim()) as { denials: string[]; summary: string }
    expect(out.denials.length).toBe(7)
    expect(out.summary).toMatch(/7\/7 actions denied/)
  })

  it('schema validation failure exits 2 (SCHEMA_VALIDATION)', async () => {
    const { exitCode } = await invoke([
      'run',
      join(EXAMPLES_DIR, 'hello/hello.workflow.mts'),
      '--input',
      '{"name":""}', // fails min(1)
    ])
    expect(exitCode).toBe(EXIT.SCHEMA_VALIDATION)
  })

  it('acp serve exits 1 with not-yet-implemented message (P5.2 seam)', async () => {
    const { stderr, exitCode } = await invoke(['acp', 'serve'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toMatch(/not yet implemented/)
  })

  it('acp with no subcommand exits 1 with usage hint', async () => {
    const { stderr, exitCode } = await invoke(['acp'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toMatch(/acp requires serve/)
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
