import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

// BUG-087/088/089: typed errors (BackendCapabilityError, PermissionDeniedError,
// …) were thrown correctly but the CLI's human-mode `step.error` line printed
// only the message, so the class name never appeared in output and callers
// couldn't recognize the error type. The renderer now prefixes the typed name.
const FIXTURES = fileURLToPath(new URL('./fixtures/exit-codes/', import.meta.url))

class Capture extends Writable {
  chunks: string[] = []
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(chunk.toString('utf8'))
    cb()
  }
  text(): string {
    return this.chunks.join('')
  }
}

async function runWorkflow(file: string): Promise<{ stderr: string }> {
  const stdout = new Capture()
  const stderr = new Capture()
  const stdin = Readable.from([])
  await main(['run', join(FIXTURES, file)], { stdout, stderr, stdin })
  return { stderr: stderr.text() }
}

describe('skelm run — step.error renders the typed error class', () => {
  it('prefixes a meaningful error class name on the step line', async () => {
    const { stderr } = await runWorkflow('typed-step-error.workflow.mts')
    expect(stderr).toMatch(/! boom: TypedBoomError: typed boom message/)
  })

  it('does not add a redundant "Error:" prefix for a plain Error', async () => {
    const { stderr } = await runWorkflow('run-failed.workflow.mts')
    expect(stderr).toMatch(/! boom: intentional failure/)
    expect(stderr).not.toMatch(/! boom: Error:/)
  })
})
