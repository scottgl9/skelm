import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

describe('skelm init', () => {
  it('scaffolds a skelm project with the expected files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-init-'))
    const target = join(dir, 'my-bot')

    const { stdout, exitCode } = await invoke(['init', target])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout).toContain('scaffolded skelm project')

    expect(readFileSync(join(target, 'package.json'), 'utf8')).toContain('"name": "skelm-project"')
    expect(readFileSync(join(target, 'tsconfig.json'), 'utf8')).toContain('"strict": true')
    expect(readFileSync(join(target, 'skelm.config.ts'), 'utf8')).toContain("networkEgress: 'deny'")
    const wf = readFileSync(join(target, 'workflows/hello.workflow.ts'), 'utf8')
    expect(wf).toContain("id: 'hello'")
    expect(wf).toContain("from 'skelm'")
    expect(readFileSync(join(target, '.gitignore'), 'utf8')).toContain('node_modules/')
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toContain('skelm-project')
  })

  it('refuses to scaffold over a non-empty directory without --force', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-init-'))
    writeFileSync(join(dir, 'existing.txt'), 'hi')

    const { exitCode, stderr } = await invoke(['init', dir])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toMatch(/not empty/)
  })

  it('--force allows scaffolding into an existing directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-init-'))
    writeFileSync(join(dir, 'existing.txt'), 'hi')

    const { exitCode } = await invoke(['init', dir, '--force'])
    expect(exitCode).toBe(EXIT.OK)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('skelm-project')
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
