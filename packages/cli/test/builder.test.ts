import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('skelm builder', () => {
  it('scaffolds a builder project and prints install next-steps (no deps yet)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-builder-'))
    const target = join(dir, 'builder')

    const { stdout, exitCode } = await invoke(['builder', target])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout).toContain('scaffolded skelm builder')
    // Deps aren't installed, so it must NOT try to launch — it instructs instead.
    expect(stdout).toContain('npm install')
    expect(stdout).not.toContain('starting skelm builder')

    expect(readFileSync(join(target, 'package.json'), 'utf8')).toContain('"name": "skelm-builder"')
    const config = readFileSync(join(target, 'skelm.config.mts'), 'utf8')
    expect(config).toContain('createRoutingBackend')
    expect(config).toContain("transport: 'tui'")
    // The config must raise the default permission ceiling, or the persistent
    // turn's default-deny would clobber the agent's grants (egress/fs/exec/skill).
    expect(config).toContain('defaults:')
    expect(config).toContain("networkEgress: 'allow'")
    const wf = readFileSync(join(target, 'builder.workflow.mts'), 'utf8')
    expect(wf).toContain("id: 'skelm-builder'")
    expect(wf).toContain('persistentWorkflow')
    expect(readFileSync(join(target, 'chatui-frontend.mts'), 'utf8')).toContain(
      'createTerminalFrontend',
    )
    expect(readFileSync(join(target, '.gitignore'), 'utf8')).toContain('node_modules/')
    // The skelm skill is scaffolded for the agent's allowedSkills: ['skelm'].
    expect(readFileSync(join(target, 'skills/skelm/SKILL.md'), 'utf8')).toContain('name: skelm')
  })

  it('is idempotent: re-running over a scaffolded project does not error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-builder-'))
    const target = join(dir, 'builder')

    await invoke(['builder', target])
    // Mutate a scaffolded file; a second run must not clobber it (already scaffolded).
    const wfPath = join(target, 'builder.workflow.mts')
    writeFileSync(wfPath, '// edited by user\n')

    const { exitCode, stdout } = await invoke(['builder', target])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout).not.toContain('scaffolded skelm builder')
    expect(readFileSync(wfPath, 'utf8')).toBe('// edited by user\n')
  })

  it('--force re-scaffolds an already-scaffolded project (refreshes templates)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-builder-'))
    const target = join(dir, 'builder')

    await invoke(['builder', target])
    const wfPath = join(target, 'builder.workflow.mts')
    writeFileSync(wfPath, '// edited by user\n')

    const { exitCode, stdout } = await invoke(['builder', target, '--force'])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout).toContain('re-scaffolded skelm builder')
    // --force overwrites the edited file back to the template.
    expect(readFileSync(wfPath, 'utf8')).toContain("id: 'skelm-builder'")
  })

  it('refuses a non-empty directory without --force', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-builder-'))
    writeFileSync(join(dir, 'existing.txt'), 'hi')

    const { exitCode, stderr } = await invoke(['builder', dir])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toMatch(/not empty/)
  })

  it('--force scaffolds into an existing directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-builder-'))
    writeFileSync(join(dir, 'existing.txt'), 'hi')

    const { exitCode } = await invoke(['builder', dir, '--force'])
    expect(exitCode).toBe(EXIT.OK)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('skelm-builder')
  })

  it('help lists the builder command', async () => {
    const { stdout } = await invoke(['builder', '--help'])
    expect(stdout).toContain('skelm builder')
    expect(stdout).toContain('SKELM_BUILDER_BACKEND')
  })

  it('the bundled skelm skill matches the canonical source (no drift)', () => {
    const bundled = readFileSync(join(here, '..', 'assets', 'skelm-skill', 'SKILL.md'), 'utf8')
    const canonical = readFileSync(
      resolve(here, '..', '..', '..', 'skill', 'skelm', 'SKILL.md'),
      'utf8',
    )
    // If this fails, rebuild the CLI to refresh the bundled copy:
    //   pnpm --filter @skelm/cli build
    expect(bundled).toBe(canonical)
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
