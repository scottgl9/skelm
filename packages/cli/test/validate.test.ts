import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

const FIX = join(import.meta.dirname, 'fixtures')
const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('skelm validate', () => {
  it('exits 0 on a clean pipeline file', async () => {
    const r = await invoke(['validate', join(FIX, 'hello.workflow.mts')])
    expect(r.exitCode).toBe(EXIT.OK)
    expect(r.stdout).toMatch(/ok:/)
  })

  it('flags an agent step that omits permissions{}', async () => {
    const r = await invoke(['validate', join(FIX, 'agent-no-permissions.workflow.mts')])
    expect(r.exitCode).toBe(EXIT.SCHEMA_VALIDATION)
    expect(r.stderr).toMatch(/agent-missing-permissions/)
  })

  it('flags a non-identifier secret name', async () => {
    const r = await invoke(['validate', join(FIX, 'agent-bad-secret-name.workflow.mts')])
    expect(r.exitCode).toBe(EXIT.SCHEMA_VALIDATION)
    expect(r.stderr).toMatch(/agent-secret-name-shape/)
  })

  it('flags a file whose default export is not a pipeline', async () => {
    const r = await invoke(['validate', join(FIX, 'not-a-pipeline.ts')])
    expect(r.exitCode).toBe(EXIT.SCHEMA_VALIDATION)
    expect(r.stderr).toMatch(/no-default-export|load-failed/)
  })

  it('--json emits a structured report and stays exit 1 on issues', async () => {
    const r = await invoke(['validate', join(FIX, 'agent-no-permissions.workflow.mts'), '--json'])
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

  it('accepts an executable profile reference defined in the project config', async () => {
    const r = await invoke(['validate', join(FIX, 'exec-profiles/known-profile.workflow.mts')])
    expect(r.exitCode).toBe(EXIT.OK)
    expect(r.stdout).toMatch(/ok:/)
  })

  it('flags an executable profile reference the config does not define', async () => {
    const r = await invoke(['validate', join(FIX, 'exec-profiles/unknown-profile.workflow.mts')])
    expect(r.exitCode).toBe(EXIT.SCHEMA_VALIDATION)
    expect(r.stderr).toMatch(/unknown-executable-profile/)
    expect(r.stderr).toMatch(/doesNotExist/)
  })

  it('accepts an executable profile reference defined in skelm.gateway.*', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skelm-validate-gateway-exec-'))
    tempDirs.push(dir)
    await writeFile(
      join(dir, 'skelm.gateway.mts'),
      `export default { defaults: { executableProfiles: { gitReadOnly: { executables: ['git'] } } } }\n`,
    )
    const workflow = join(dir, 'known-from-gateway.workflow.mts')
    await writeFile(
      workflow,
      `import { agent, pipeline } from '@skelm/core'

export default pipeline({
  id: 'known-from-gateway',
  steps: [
    agent({
      id: 'reviewer',
      prompt: 'review this',
      permissions: { executableProfiles: ['gitReadOnly'] },
    }),
  ],
})
`,
    )
    const r = await invoke(['validate', workflow])
    expect(r.exitCode).toBe(EXIT.OK)
    expect(r.stdout).toMatch(/ok:/)
  })

  it('flags unknown executable profiles referenced through a named permission profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skelm-validate-profile-exec-'))
    tempDirs.push(dir)
    await writeFile(
      join(dir, 'skelm.config.mts'),
      `export default {
  defaults: {
    permissionProfiles: {
      analyst: { executableProfiles: ['doesNotExist'] },
    },
  },
}
`,
    )
    const workflow = join(dir, 'named-profile.workflow.mts')
    await writeFile(
      workflow,
      `import { agent, pipeline } from '@skelm/core'

export default pipeline({
  id: 'named-profile',
  steps: [
    agent({
      id: 'reviewer',
      prompt: 'review this',
      permissions: { profile: 'analyst' },
    }),
  ],
})
`,
    )
    const r = await invoke(['validate', workflow])
    expect(r.exitCode).toBe(EXIT.SCHEMA_VALIDATION)
    expect(r.stderr).toMatch(/unknown-executable-profile/)
    expect(r.stderr).toMatch(/doesNotExist/)
    expect(r.stderr).toMatch(/analyst/)
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
