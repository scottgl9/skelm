import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'
import { type InProcessGateway, bootInProcessGateway } from './_helpers/gateway-harness.js'

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url))
const PROJECT_FIXTURE_DIR = join(FIXTURES_DIR, 'project')

let gw: InProcessGateway
let priorStateDir: string | undefined
let priorNoAutostart: string | undefined

beforeAll(async () => {
  priorStateDir = process.env.SKELM_STATE_DIR
  priorNoAutostart = process.env.SKELM_NO_AUTOSTART
  gw = await bootInProcessGateway({
    projectRoot: PROJECT_FIXTURE_DIR,
    config: {
      registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
    },
  })
}, 30_000)

afterAll(async () => {
  await gw?.stop()
  process.env.SKELM_STATE_DIR = priorStateDir
  process.env.SKELM_NO_AUTOSTART = priorNoAutostart
})

describe('skelm list / describe — via gateway with projectRoot', () => {
  it('list surfaces workflows from the gateway registry', async () => {
    const { stdout, exitCode } = await invoke(['list'])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout).toContain('alpha-workflow')
    expect(stdout).toContain('graph-workflow')
  })

  it('describe <id> renders the gateway-side step graph', async () => {
    const { stdout, exitCode } = await invoke(['describe', 'graph-workflow'])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout).toContain('- fanout (parallel)')
    expect(stdout).toContain('- route (branch)')
    expect(stdout).toContain('- repeat (loop)')
    expect(stdout).toContain('- collect (forEach)')
  })

  it('describe <id> --format mermaid renders the graph', async () => {
    const { stdout, exitCode } = await invoke(['describe', 'graph-workflow', '--format', 'mermaid'])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout).toContain('flowchart TD')
    expect(stdout).toContain('parallel: fanout')
    expect(stdout).toContain('branch: route')
    expect(stdout).toContain('loop: repeat')
    expect(stdout).toContain('forEach: collect')
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
