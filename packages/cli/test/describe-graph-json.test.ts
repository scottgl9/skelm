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

describe('skelm describe --format graph-json', () => {
  it('emits a valid WorkflowGraph JSON for a control-flow workflow', async () => {
    const { stdout, exitCode } = await invoke([
      'describe',
      join(FIXTURES, 'control-flow.workflow.mts'),
      '--format',
      'graph-json',
    ])

    expect(exitCode).toBe(EXIT.OK)

    const graph = JSON.parse(stdout)
    expect(graph.id).toBe('control-flow')
    expect(graph.kind).toBe('pipeline')
    expect(graph.nodes.map((n: { kind: string }) => n.kind)).toEqual([
      'parallel',
      'forEach',
      'branch',
      'loop',
      'code',
    ])
    // Control-flow nesting and codeOwned flags survive the round trip.
    const branchNode = graph.nodes.find((n: { kind: string }) => n.kind === 'branch')
    expect(branchNode.codeOwned).toBe(true)
    expect(branchNode.children.map((c: { data: { case: string } }) => c.data.case)).toEqual([
      'fast',
      'slow',
      'default',
    ])
    // No author functions leak into the JSON.
    expect(stdout).not.toContain('[Function]')
    expect(stdout).not.toMatch(/=>/)
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
