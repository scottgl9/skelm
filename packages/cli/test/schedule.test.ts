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
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-cli-sched-'))
  priorStateDir = process.env.SKELM_STATE_DIR
  process.env.SKELM_STATE_DIR = stateDir
})

afterEach(async () => {
  if (priorStateDir === undefined) process.env.SKELM_STATE_DIR = undefined
  else process.env.SKELM_STATE_DIR = priorStateDir
  await rm(stateDir, { recursive: true, force: true })
})

describe('skelm schedule — CLI smoke', () => {
  it('errors out with usage when invoked without a subcommand', async () => {
    const { stderr, exitCode } = await invoke(['schedule'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toContain('schedule requires')
  })

  it('errors out when the gateway is not running', async () => {
    const { stderr, exitCode } = await invoke(['schedule', 'list'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toContain('gateway is not running')
  })

  it('add --cron → list → stop round-trip against a real gateway', async () => {
    const gw = await startGatewayOnFreePort(stateDir)
    try {
      // Empty list
      const empty = await invoke(['schedule', 'list'])
      expect(empty.exitCode).toBe(EXIT.OK)
      expect(empty.stdout).toContain('no schedules registered')

      // Add a cron schedule
      const added = await invoke([
        'schedule',
        'add',
        'my-workflow',
        '--id',
        'my-sched',
        '--cron',
        '0 * * * *',
      ])
      expect(added.exitCode).toBe(EXIT.OK)
      expect(added.stdout).toContain('my-sched')
      expect(added.stdout).toContain('my-workflow')

      // List shows it
      const list = await invoke(['schedule', 'list'])
      expect(list.exitCode).toBe(EXIT.OK)
      expect(list.stdout).toContain('my-sched')

      // --json list
      const jsonList = await invoke(['schedule', 'list', '--json'])
      expect(jsonList.exitCode).toBe(EXIT.OK)
      const schedules = JSON.parse(jsonList.stdout) as Array<{ id: string; workflowId: string }>
      expect(schedules.find((s) => s.id === 'my-sched')?.workflowId).toBe('my-workflow')

      // Stop removes it
      const stopped = await invoke(['schedule', 'stop', 'my-sched'])
      console.log('stop:', JSON.stringify(stopped))
      expect(stopped.exitCode).toBe(EXIT.OK)
      expect(stopped.stdout).toContain('stopped my-sched')

      // Gone from list
      const after = await invoke(['schedule', 'list'])
      expect(after.stdout).toContain('no schedules registered')
    } finally {
      await gw.stop()
    }
  })

  it('stop returns CLI_ERROR for unknown schedule id', async () => {
    const gw = await startGatewayOnFreePort(stateDir)
    try {
      const result = await invoke(['schedule', 'stop', 'no-such-id'])
      expect(result.exitCode).toBe(EXIT.CLI_ERROR)
      expect(result.stderr).toContain('not found')
    } finally {
      await gw.stop()
    }
  })

  it('add --webhook registers a webhook trigger', async () => {
    const gw = await startGatewayOnFreePort(stateDir)
    try {
      const added = await invoke([
        'schedule',
        'add',
        'hook-workflow',
        '--id',
        'my-hook',
        '--webhook',
        '/deploy',
      ])
      expect(added.exitCode).toBe(EXIT.OK)
      expect(added.stdout).toContain('webhook(/deploy)')
    } finally {
      await gw.stop()
    }
  })

  it('add --cron --json returns the schedule as JSON', async () => {
    const gw = await startGatewayOnFreePort(stateDir)
    try {
      const result = await invoke([
        'schedule',
        'add',
        'json-wf',
        '--id',
        'json-sched',
        '--cron',
        '0 9 * * 1',
        '--json',
      ])
      expect(result.exitCode).toBe(EXIT.OK)
      const s = JSON.parse(result.stdout) as { id: string; trigger: { kind: string } }
      expect(s.id).toBe('json-sched')
      expect(s.trigger.kind).toBe('cron')
    } finally {
      await gw.stop()
    }
  })

  it('add --cron --tz wires timezone through to the registered trigger', async () => {
    const gw = await startGatewayOnFreePort(stateDir)
    try {
      const result = await invoke([
        'schedule',
        'add',
        'tz-wf',
        '--id',
        'tz-sched',
        '--cron',
        '0 9 * * 1',
        '--tz',
        'America/Chicago',
        '--json',
      ])
      expect(result.exitCode).toBe(EXIT.OK)
      const s = JSON.parse(result.stdout) as {
        trigger: { kind: string; expression: string; tz?: string }
      }
      expect(s.trigger.kind).toBe('cron')
      expect(s.trigger.expression).toBe('0 9 * * 1')
      // Regression for issue #157: --tz used to be silently dropped.
      expect(s.trigger.tz).toBe('America/Chicago')
    } finally {
      await gw.stop()
    }
  })

  it('add --every <duration> registers an interval trigger', async () => {
    const gw = await startGatewayOnFreePort(stateDir)
    try {
      const result = await invoke([
        'schedule',
        'add',
        'every-wf',
        '--id',
        'every-sched',
        '--every',
        '30s',
        '--json',
      ])
      expect(result.exitCode).toBe(EXIT.OK)
      const s = JSON.parse(result.stdout) as {
        trigger: { kind: string; everyMs: number; every?: string }
      }
      expect(s.trigger.kind).toBe('interval')
      expect(s.trigger.everyMs).toBe(30_000)
      // Regression for issue #158: --every was not accepted at all.
      expect(s.trigger.every).toBe('30s')
    } finally {
      await gw.stop()
    }
  })

  it('add --tz without --cron rejects', async () => {
    const gw = await startGatewayOnFreePort(stateDir)
    try {
      const { stderr, exitCode } = await invoke([
        'schedule',
        'add',
        'wf',
        '--every',
        '30s',
        '--tz',
        'America/Chicago',
      ])
      expect(exitCode).toBe(EXIT.CLI_ERROR)
      expect(stderr).toContain('--tz requires --cron')
    } finally {
      await gw.stop()
    }
  })

  it('add without trigger flag exits CLI_ERROR', async () => {
    const gw = await startGatewayOnFreePort(stateDir)
    try {
      const result = await invoke(['schedule', 'add', 'wf'])
      expect(result.exitCode).toBe(EXIT.CLI_ERROR)
      expect(result.stderr).toContain('--cron')
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

/**
 * Start a real Gateway listening on a kernel-assigned free port, retrying
 * on EADDRINUSE. There is an inherent TOCTOU race between picking a port
 * (open + close a temp listener on :0) and the gateway binding it: parallel
 * vitest workers occasionally race onto the same ephemeral port and one
 * loses with `Error: listen EADDRINUSE`. Retrying with a fresh pick removes
 * the flake while keeping the test against a real HTTP server.
 */
async function startGatewayOnFreePort(stateDir: string): Promise<Gateway> {
  const MAX_ATTEMPTS = 6
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const port = await pickFreePort()
    const gw = new Gateway({
      stateDir,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      url: `http://127.0.0.1:${port}`,
      config: {},
    })
    try {
      await gw.start()
      return gw
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'EADDRINUSE') throw err
      // Failed gw may have already initialized some listeners — make sure
      // we don't leak them across the retry.
      await gw.stop().catch(() => {})
    }
  }
  throw lastErr ?? new Error(`could not bind a free port after ${MAX_ATTEMPTS} attempts`)
}
