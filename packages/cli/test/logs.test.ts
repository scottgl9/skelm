import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

let logPath: string
const original = process.env.SKELM_GATEWAY_LOG

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'skelm-logs-'))
  logPath = join(dir, 'gateway.log')
  process.env.SKELM_GATEWAY_LOG = logPath
})

afterEach(() => {
  process.env.SKELM_GATEWAY_LOG = original
})

const sample = [
  { timestamp: '2026-05-05T10:00:00Z', level: 'info', message: 'started' },
  { timestamp: '2026-05-05T10:01:00Z', level: 'warn', message: 'slow query' },
  { timestamp: '2026-05-05T10:02:00Z', level: 'error', message: 'auth failed' },
]

function writeSample() {
  writeFileSync(logPath, `${sample.map((e) => JSON.stringify(e)).join('\n')}\n`)
}

describe('skelm logs', () => {
  it('prints all lines in human format by default', async () => {
    writeSample()
    const r = await invoke(['logs'])
    expect(r.exitCode).toBe(EXIT.OK)
    expect(r.stdout).toMatch(/started/)
    expect(r.stdout).toMatch(/slow query/)
    expect(r.stdout).toMatch(/auth failed/)
  })

  it('limits output with --lines', async () => {
    writeSample()
    const r = await invoke(['logs', '--lines', '1'])
    expect(r.exitCode).toBe(EXIT.OK)
    expect(r.stdout).not.toMatch(/started/)
    expect(r.stdout).toMatch(/auth failed/)
  })

  it('rejects non-numeric --lines', async () => {
    writeSample()
    const r = await invoke(['logs', '--lines', 'nope'])
    expect(r.exitCode).toBe(EXIT.CLI_ERROR)
    expect(r.stderr).toContain('--lines must be a non-negative integer')
    expect(r.stdout).toBe('')
  })

  it('filters by --level', async () => {
    writeSample()
    const r = await invoke(['logs', '--level', 'error'])
    expect(r.stdout).not.toMatch(/started/)
    expect(r.stdout).not.toMatch(/slow query/)
    expect(r.stdout).toMatch(/auth failed/)
  })

  it('rejects an unknown --level', async () => {
    writeSample()
    const r = await invoke(['logs', '--level', 'banana'])
    expect(r.exitCode).toBe(EXIT.CLI_ERROR)
    expect(r.stderr).toContain('--level must be one of: debug, info, warn, error')
    expect(r.stdout).toBe('')
  })

  it('filters by --since', async () => {
    writeSample()
    const r = await invoke(['logs', '--since', '2026-05-05T10:01:30Z'])
    expect(r.stdout).not.toMatch(/started/)
    expect(r.stdout).not.toMatch(/slow query/)
    expect(r.stdout).toMatch(/auth failed/)
  })

  it('--json emits raw JSON-Lines', async () => {
    writeSample()
    const r = await invoke(['logs', '--json', '--lines', '2'])
    const lines = r.stdout.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(() => JSON.parse(lines[0] ?? '')).not.toThrow()
  })

  it('--filter narrows to substring matches', async () => {
    writeSample()
    const r = await invoke(['logs', '--filter', 'slow'])
    expect(r.stdout).toMatch(/slow query/)
    expect(r.stdout).not.toMatch(/auth failed/)
  })

  it('errors when the log file is missing', async () => {
    const r = await invoke(['logs'])
    expect(r.exitCode).toBe(EXIT.CLI_ERROR)
    expect(r.stderr).toMatch(/not found/)
  })

  it('rejects a malformed --since', async () => {
    writeSample()
    const r = await invoke(['logs', '--since', 'not-a-date'])
    expect(r.exitCode).toBe(EXIT.CLI_ERROR)
    expect(r.stderr).toMatch(/ISO-8601/)
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
