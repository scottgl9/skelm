import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'
import { type InProcessGateway, bootInProcessGateway } from './_helpers/gateway-harness.js'

let gw: InProcessGateway
let priorStateDir: string | undefined
let priorNoAutostart: string | undefined

beforeAll(async () => {
  priorStateDir = process.env.SKELM_STATE_DIR
  priorNoAutostart = process.env.SKELM_NO_AUTOSTART
  gw = await bootInProcessGateway()
}, 30_000)

afterAll(async () => {
  await gw?.stop()
  process.env.SKELM_STATE_DIR = priorStateDir
  process.env.SKELM_NO_AUTOSTART = priorNoAutostart
})

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

/**
 * Verifies that `skelm describe --format mermaid` renders all structural step
 * kinds (parallel, forEach, branch, loop) correctly. This locks the mermaid
 * renderer against regressions and satisfies the M2 acceptance criterion that
 * `describe --format mermaid` must cover control-flow step kinds.
 */
describe('skelm describe --format mermaid', () => {
  it('renders parallel, forEach, branch, and loop steps', async () => {
    const { stdout, exitCode } = await invoke([
      'describe',
      join(FIXTURES, 'control-flow.workflow.mts'),
      '--format',
      'mermaid',
    ])

    expect(exitCode).toBe(EXIT.OK)

    // flowchart header
    expect(stdout).toContain('flowchart TD')

    // parallel block with both children connected
    expect(stdout).toMatch(/parallel: fan-out/)
    expect(stdout).toMatch(/code: left/)
    expect(stdout).toMatch(/code: right/)

    // forEach rendered as a leaf (factory body cannot be described statically)
    expect(stdout).toMatch(/forEach: each-item/)

    // branch block with case labels
    expect(stdout).toMatch(/branch: route/)
    expect(stdout).toMatch(/\|fast\|/)
    expect(stdout).toMatch(/\|slow\|/)
    expect(stdout).toMatch(/\|default\|/)
    expect(stdout).toMatch(/code: fast-path/)
    expect(stdout).toMatch(/code: slow-path/)
    expect(stdout).toMatch(/code: default-path/)

    // loop with its body child
    expect(stdout).toMatch(/loop: retry-loop/)
    expect(stdout).toMatch(/code: loop-body/)
  })

  it('exits 0 for human format', async () => {
    const { stdout, exitCode } = await invoke([
      'describe',
      join(FIXTURES, 'control-flow.workflow.mts'),
    ])
    expect(exitCode).toBe(EXIT.OK)
    expect(stdout).toContain('workflow: control-flow')
    expect(stdout).toContain('- fan-out (parallel)')
    expect(stdout).toContain('- route (branch)')
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
