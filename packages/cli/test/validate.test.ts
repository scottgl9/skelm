import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

const FIX = join(import.meta.dirname, 'fixtures')

describe('skelm validate', () => {
  it('exits 0 on a clean pipeline file', async () => {
    const r = await invoke(['validate', join(FIX, 'hello.workflow.ts')])
    expect(r.exitCode).toBe(EXIT.OK)
    expect(r.stdout).toMatch(/ok:/)
  })

  it('flags an agent step that omits permissions{}', async () => {
    const r = await invoke(['validate', join(FIX, 'agent-no-permissions.workflow.ts')])
    expect(r.exitCode).toBe(EXIT.SCHEMA_VALIDATION)
    expect(r.stderr).toMatch(/agent-missing-permissions/)
  })

  it('flags a non-identifier secret name', async () => {
    const r = await invoke(['validate', join(FIX, 'agent-bad-secret-name.workflow.ts')])
    expect(r.exitCode).toBe(EXIT.SCHEMA_VALIDATION)
    expect(r.stderr).toMatch(/agent-secret-name-shape/)
  })

  it('flags a file whose default export is not a pipeline', async () => {
    const r = await invoke(['validate', join(FIX, 'not-a-pipeline.ts')])
    expect(r.exitCode).toBe(EXIT.SCHEMA_VALIDATION)
    expect(r.stderr).toMatch(/no-default-export|load-failed/)
  })

  it('--json emits a structured report and stays exit 1 on issues', async () => {
    const r = await invoke(['validate', join(FIX, 'agent-no-permissions.workflow.ts'), '--json'])
    expect(r.exitCode).toBe(EXIT.SCHEMA_VALIDATION)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.ok).toBe(false)
    expect(Array.isArray(parsed.issues)).toBe(true)
    expect(parsed.issues[0].code).toBe('agent-missing-permissions')
  })

  it('errors with EXIT.CLI_ERROR and a usage hint when no path is given', async () => {
    // Argv-level error caught by main before validateCommand runs; that's a
    // generic CLI_ERROR, not a workflow validation failure.
    const r = await invoke(['validate'])
    expect(r.exitCode).toBe(EXIT.CLI_ERROR)
    expect(r.stderr).toMatch(/requires <pipeline-path>/)
  })

  it('errors when the file does not exist', async () => {
    const r = await invoke(['validate', join(FIX, 'does-not-exist.ts')])
    expect(r.exitCode).toBe(EXIT.SCHEMA_VALIDATION)
    expect(r.stderr).toMatch(/load-failed|not found/)
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
