import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { Gateway } from '@skelm/gateway'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

let stateDir: string
let priorStateDir: string | undefined

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-cli-dbg-'))
  priorStateDir = process.env.SKELM_STATE_DIR
  process.env.SKELM_STATE_DIR = stateDir
})

afterEach(async () => {
  if (priorStateDir === undefined) process.env.SKELM_STATE_DIR = undefined
  else process.env.SKELM_STATE_DIR = priorStateDir
  await rm(stateDir, { recursive: true, force: true })
})

describe('skelm debug — CLI smoke', () => {
  it('errors out with usage when invoked without a subcommand', async () => {
    const { stderr, exitCode } = await invoke(['debug'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toContain('debug requires')
  })

  it('errors out when the gateway is not running', async () => {
    const { stderr, exitCode } = await invoke(['debug', 'breakpoints'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toContain('gateway is not running')
  })

  it('add → breakpoints → remove round-trip against a real gateway', async () => {
    const port = await pickFreePort()
    const gw = new Gateway({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      url: `http://127.0.0.1:${port}`,
      config: {},
    })
    await gw.start()
    try {
      const added = await invoke(['debug', 'add', 'agent-step'])
      expect(added.exitCode).toBe(EXIT.OK)
      expect(added.stdout).toContain('added agent-step')

      const list = await invoke(['debug', 'breakpoints'])
      expect(list.exitCode).toBe(EXIT.OK)
      expect(list.stdout).toContain('agent-step')

      const removed = await invoke(['debug', 'remove', 'agent-step'])
      expect(removed.exitCode).toBe(EXIT.OK)
      expect(removed.stdout).toContain('removed agent-step')

      const empty = await invoke(['debug', 'breakpoints'])
      expect(empty.stdout).toContain('no breakpoints set')
    } finally {
      await gw.stop()
    }
  })

  it('release fires against a paused run and returns the run id', async () => {
    const port = await pickFreePort()
    const gw = new Gateway({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      url: `http://127.0.0.1:${port}`,
      config: {},
    })
    await gw.start()
    try {
      const pausePromise = gw.breakpoints.pause({
        runId: 'r-cli',
        stepId: 'agent-step',
        kind: 'agent',
      })

      const list = await invoke(['debug', 'runs', '--json'])
      expect(list.exitCode).toBe(EXIT.OK)
      const paused = JSON.parse(list.stdout) as Array<{ runId: string }>
      expect(paused.map((p) => p.runId)).toContain('r-cli')

      const released = await invoke(['debug', 'release', 'r-cli'])
      expect(released.exitCode).toBe(EXIT.OK)
      expect(released.stdout).toContain('released r-cli')
      await pausePromise
    } finally {
      await gw.stop()
    }
  })
})

interface InvokeResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function invoke(argv: readonly string[]): Promise<InvokeResult> {
  let stdout = ''
  let stderr = ''
  const result = await main(argv, {
    stdout: makeWritable((s) => {
      stdout += s
    }),
    stderr: makeWritable((s) => {
      stderr += s
    }),
    stdin: Readable.from([]),
  })
  return { stdout, stderr, exitCode: result.exitCode }
}

function makeWritable(append: (s: string) => void): Writable {
  return new Writable({
    write(chunk, _enc, cb) {
      append(chunk.toString())
      cb()
    },
  })
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close()
        reject(new Error('port pick failed'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}
