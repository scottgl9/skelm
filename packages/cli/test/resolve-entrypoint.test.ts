import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { CliError } from '../src/load-workflow.js'
import { main } from '../src/main.js'
import { resolveWorkflowPath } from '../src/resolve-entrypoint.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skelm-entrypoint-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function touch(name: string, body = ''): string {
  const p = join(dir, name)
  writeFileSync(p, body)
  return p
}

describe('resolveWorkflowPath', () => {
  it('returns a file path unchanged (made absolute)', async () => {
    const file = touch('one.workflow.mts')
    expect(await resolveWorkflowPath(file)).toBe(file)
    // relative form resolves against the provided cwd
    expect(await resolveWorkflowPath('one.workflow.mts', dir)).toBe(file)
  })

  it('defers a non-existent path to the gateway (returns absolute, no throw)', async () => {
    const missing = join(dir, 'nope.workflow.mts')
    expect(await resolveWorkflowPath(missing)).toBe(missing)
  })

  it('resolves a directory via the config entrypoint', async () => {
    const entry = touch('app.workflow.mts')
    touch('skelm.config.mjs', "export default { entrypoint: './app.workflow.mts' }\n")
    expect(await resolveWorkflowPath(dir)).toBe(entry)
  })

  it('throws when the config entrypoint points at a missing file', async () => {
    touch('skelm.config.mjs', "export default { entrypoint: './ghost.workflow.mts' }\n")
    await expect(resolveWorkflowPath(dir)).rejects.toMatchObject({
      code: 'entrypoint-unresolved',
    })
  })

  it('falls back to index.workflow.mts when no config entrypoint is set', async () => {
    const entry = touch('index.workflow.mts')
    touch('other.workflow.mts')
    touch('skelm.config.mjs', 'export default {}\n')
    expect(await resolveWorkflowPath(dir)).toBe(entry)
  })

  it('falls back to a single workflow file when there is exactly one', async () => {
    const entry = touch('only.pipeline.ts')
    expect(await resolveWorkflowPath(dir)).toBe(entry)
  })

  it('throws on an empty directory', async () => {
    await expect(resolveWorkflowPath(dir)).rejects.toBeInstanceOf(CliError)
  })

  it('throws when multiple workflow files are ambiguous (no entrypoint/index)', async () => {
    touch('a.workflow.mts')
    touch('b.workflow.mts')
    await expect(resolveWorkflowPath(dir)).rejects.toMatchObject({
      code: 'entrypoint-unresolved',
    })
  })
})

describe('skelm run <directory> integration', () => {
  it('exits CLI_ERROR with a clear message for an unresolvable directory', async () => {
    // Resolution happens before any gateway contact, so this needs no gateway.
    const r = await invoke(['run', dir])
    expect(r.exitCode).toBe(EXIT.CLI_ERROR)
    expect(r.stderr).toMatch(/no workflow found/)
  })
})

async function invoke(argv: readonly string[]) {
  const out: string[] = []
  const err: string[] = []
  const stdout = new Writable({
    write(c, _e, cb) {
      out.push(c.toString())
      cb()
    },
  })
  const stderr = new Writable({
    write(c, _e, cb) {
      err.push(c.toString())
      cb()
    },
  })
  const result = await main(argv, { stdout, stderr, stdin: Readable.from([]) })
  return { stdout: out.join(''), stderr: err.join(''), exitCode: result.exitCode }
}
