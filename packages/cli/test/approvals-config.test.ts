import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

let configPath: string
const original = process.env.SKELM_APPROVALS_CONFIG

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'skelm-approvals-config-'))
  configPath = join(dir, 'approvals.config.json')
  process.env.SKELM_APPROVALS_CONFIG = configPath
})

afterEach(() => {
  process.env.SKELM_APPROVALS_CONFIG = original
})

describe('skelm approvals config', () => {
  it('show emits an empty policy when the file is missing', async () => {
    const r = await invoke(['approvals', 'config', 'show', '--json'])
    expect(r.exitCode).toBe(EXIT.OK)
    expect(JSON.parse(r.stdout)).toEqual({})
  })

  it('show prints a populated policy in human format', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultTimeoutMs: 60000,
        stepKindsRequiringApproval: ['agent'],
        approvers: [{ id: 'alice', email: 'alice@example.com' }],
      }),
    )
    const r = await invoke(['approvals', 'config', 'show'])
    expect(r.exitCode).toBe(EXIT.OK)
    expect(r.stdout).toMatch(/defaultTimeoutMs: 60000/)
    expect(r.stdout).toMatch(/agent/)
    expect(r.stdout).toMatch(/alice/)
  })

  it('validate exits 0 on a clean policy', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultTimeoutMs: 1000,
        stepKindsRequiringApproval: ['agent', 'wait'],
        approvers: [{ id: 'a' }],
      }),
    )
    const r = await invoke(['approvals', 'config', 'validate'])
    expect(r.exitCode).toBe(EXIT.OK)
    expect(r.stdout).toMatch(/ok:/)
  })

  it('validate flags an unknown step kind', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        stepKindsRequiringApproval: ['agent', 'not-a-real-kind'],
      }),
    )
    const r = await invoke(['approvals', 'config', 'validate'])
    expect(r.exitCode).toBe(EXIT.CLI_ERROR)
    expect(r.stderr).toMatch(/unknown-step-kind/)
  })

  it('validate flags duplicate approver ids', async () => {
    writeFileSync(configPath, JSON.stringify({ approvers: [{ id: 'a' }, { id: 'a' }] }))
    const r = await invoke(['approvals', 'config', 'validate'])
    expect(r.exitCode).toBe(EXIT.CLI_ERROR)
    expect(r.stderr).toMatch(/approver-duplicate-id/)
  })

  it('validate flags a parse error', async () => {
    writeFileSync(configPath, '{not json')
    const r = await invoke(['approvals', 'config', 'validate', '--json'])
    expect(r.exitCode).toBe(EXIT.CLI_ERROR)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.ok).toBe(false)
    expect(parsed.issues[0].code).toBe('parse-error')
  })

  it('set defaultTimeoutMs updates the file atomically', async () => {
    const r = await invoke(['approvals', 'config', 'set', 'defaultTimeoutMs', '90000'])
    expect(r.exitCode).toBe(EXIT.OK)
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(parsed.defaultTimeoutMs).toBe(90000)
  })

  it('set rejects a non-positive defaultTimeoutMs', async () => {
    const r = await invoke(['approvals', 'config', 'set', 'defaultTimeoutMs', '0'])
    expect(r.exitCode).toBe(EXIT.CLI_ERROR)
  })

  it('set stepKindsRequiringApproval rejects unknown kinds', async () => {
    const r = await invoke([
      'approvals',
      'config',
      'set',
      'stepKindsRequiringApproval',
      'agent,unknown',
    ])
    expect(r.exitCode).toBe(EXIT.CLI_ERROR)
  })

  it('approvers add appends and approvers remove drops', async () => {
    let r = await invoke(['approvals', 'config', 'approvers', 'add', 'alice'])
    expect(r.exitCode).toBe(EXIT.OK)
    r = await invoke(['approvals', 'config', 'approvers', 'add', 'bob'])
    expect(r.exitCode).toBe(EXIT.OK)
    let policy = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(policy.approvers.map((a: { id: string }) => a.id)).toEqual(['alice', 'bob'])

    // Idempotency: adding alice again is an explicit error (operator chose
    // 'add', not 'set'); drives intent + audit.
    r = await invoke(['approvals', 'config', 'approvers', 'add', 'alice'])
    expect(r.exitCode).toBe(EXIT.CLI_ERROR)

    r = await invoke(['approvals', 'config', 'approvers', 'remove', 'alice'])
    expect(r.exitCode).toBe(EXIT.OK)
    policy = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(policy.approvers.map((a: { id: string }) => a.id)).toEqual(['bob'])
  })

  it('rejects unknown action', async () => {
    const r = await invoke(['approvals', 'config', 'frob'])
    expect(r.exitCode).toBe(EXIT.CLI_ERROR)
    expect(r.stderr).toMatch(/show \| validate \| set \| approvers/)
  })

  it('rejects a top-level non-object policy file', async () => {
    writeFileSync(configPath, '[1, 2, 3]')
    const r = await invoke(['approvals', 'config', 'show', '--json'])
    expect(r.exitCode).not.toBe(EXIT.OK)
    expect(r.stderr).toMatch(/top-level value must be a JSON object/)
  })

  it('rejects approvers entries missing an id', async () => {
    writeFileSync(configPath, JSON.stringify({ approvers: [{ email: 'x@y' }] }))
    const r = await invoke(['approvals', 'config', 'show', '--json'])
    expect(r.exitCode).not.toBe(EXIT.OK)
    expect(r.stderr).toMatch(/approvers\[0\]\.id/)
  })

  it('rejects a non-numeric defaultTimeoutMs', async () => {
    writeFileSync(configPath, JSON.stringify({ defaultTimeoutMs: 'soon' }))
    const r = await invoke(['approvals', 'config', 'show', '--json'])
    expect(r.exitCode).not.toBe(EXIT.OK)
    expect(r.stderr).toMatch(/defaultTimeoutMs/)
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
