import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'
import { type InProcessGateway, bootInProcessGateway } from './_helpers/gateway-harness.js'

const FIXTURE_PACKAGE = fileURLToPath(new URL('./fixtures/package/hello/', import.meta.url))
// A project root inside the repo tree so the installed package's
// `@skelm/core` import resolves via the workspace node_modules above it.
const CLI_TEST_DIR = dirname(fileURLToPath(import.meta.url))

let gw: InProcessGateway
let projectRoot: string
let priorStateDir: string | undefined
let priorNoAutostart: string | undefined

beforeAll(async () => {
  priorStateDir = process.env.SKELM_STATE_DIR
  priorNoAutostart = process.env.SKELM_NO_AUTOSTART
  projectRoot = await mkdtemp(join(CLI_TEST_DIR, '.tmp-pkg-proj-'))
  gw = await bootInProcessGateway({ projectRoot })
}, 30_000)

afterAll(async () => {
  await gw?.stop()
  await rm(projectRoot, { recursive: true, force: true })
  process.env.SKELM_STATE_DIR = priorStateDir
  process.env.SKELM_NO_AUTOSTART = priorNoAutostart
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

describe('skelm package — via gateway', () => {
  it('install → list → info → run @skelm/hello → remove', async () => {
    // install
    const install = await invoke(['package', 'install', FIXTURE_PACKAGE])
    expect(install.exitCode).toBe(EXIT.OK)
    expect(install.stdout).toContain('installed @skelm/hello@0.1.0')

    // list
    const list = await invoke(['package', 'list'])
    expect(list.exitCode).toBe(EXIT.OK)
    expect(list.stdout).toContain('@skelm/hello')
    expect(list.stdout).toContain('0.1.0')

    // list --json
    const listJson = await invoke(['package', 'list', '--json'])
    expect(listJson.exitCode).toBe(EXIT.OK)
    expect(JSON.parse(listJson.stdout)[0]).toMatchObject({ name: '@skelm/hello' })

    // info
    const info = await invoke(['package', 'info', '@skelm/hello'])
    expect(info.exitCode).toBe(EXIT.OK)
    expect(info.stdout).toContain('versions: 0.1.0')
    expect(info.stdout).toContain('workflows: default')

    // run by spec — the resolved package entry executes like a normal file
    const run = await invoke(['run', '@skelm/hello', '--events', 'none'])
    expect(run.exitCode).toBe(EXIT.OK)
    expect(JSON.parse(run.stdout)).toEqual({ greeting: 'hello world' })

    // run an unknown entry → CLI error
    const badEntry = await invoke(['run', '@skelm/hello/nope', '--events', 'none'])
    expect(badEntry.exitCode).toBe(EXIT.CLI_ERROR)
    expect(badEntry.stderr).toMatch(/available: default/)

    // remove
    const remove = await invoke(['package', 'remove', '@skelm/hello'])
    expect(remove.exitCode).toBe(EXIT.OK)
    expect(remove.stdout).toContain('removed @skelm/hello')

    // list is empty again
    const after = await invoke(['package', 'list'])
    expect(after.stdout).toContain('No packages installed')
  })

  it('info on an unknown package exits 1', async () => {
    const res = await invoke(['package', 'info', '@skelm/nope'])
    expect(res.exitCode).toBe(EXIT.CLI_ERROR)
    expect(res.stderr).toMatch(/not installed/)
  })

  it('install with no source exits 1', async () => {
    const res = await invoke(['package', 'install'])
    expect(res.exitCode).toBe(EXIT.CLI_ERROR)
    expect(res.stderr).toMatch(/requires a source/)
  })

  it('unknown package subcommand exits 1', async () => {
    const res = await invoke(['package', 'frobnicate'])
    expect(res.exitCode).toBe(EXIT.CLI_ERROR)
    expect(res.stderr).toMatch(/install \| list \| info \| remove \| update/)
  })
})
