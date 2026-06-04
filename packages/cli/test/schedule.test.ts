import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Gateway } from '@skelm/gateway'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

let stateDir: string
let priorStateDir: string | undefined
let priorNoAutostart: string | undefined

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-cli-sched-'))
  priorStateDir = process.env.SKELM_STATE_DIR
  priorNoAutostart = process.env.SKELM_NO_AUTOSTART
  process.env.SKELM_STATE_DIR = stateDir
  // The "gateway is not running" case below deliberately exercises the
  // no-gateway path. Disable auto-start so the CLI fails fast with a clean
  // error instead of spawning a real ad-hoc gateway and waiting for readiness.
  process.env.SKELM_NO_AUTOSTART = '1'
})

afterEach(async () => {
  if (priorStateDir === undefined) process.env.SKELM_STATE_DIR = undefined
  else process.env.SKELM_STATE_DIR = priorStateDir
  if (priorNoAutostart === undefined) process.env.SKELM_NO_AUTOSTART = undefined
  else process.env.SKELM_NO_AUTOSTART = priorNoAutostart
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

  it('add rejects non-numeric --every-ms before contacting the gateway', async () => {
    const result = await invoke(['schedule', 'add', 'wf', '--every-ms', 'nope'])
    expect(result.exitCode).toBe(EXIT.CLI_ERROR)
    expect(result.stderr).toContain('--every-ms must be a non-negative integer')
  })

  it('add rejects an unknown --overlap before contacting the gateway', async () => {
    const result = await invoke([
      'schedule',
      'add',
      'wf',
      '--cron',
      '0 * * * *',
      '--overlap',
      'later',
    ])
    expect(result.exitCode).toBe(EXIT.CLI_ERROR)
    expect(result.stderr).toContain('--overlap must be one of: skip, queue, cancel')
  })

  it('add without trigger flag exits CLI_ERROR', async () => {
    const gw = await startGatewayOnFreePort(stateDir)
    try {
      const result = await invoke(['schedule', 'add', 'wf'])
      expect(result.exitCode).toBe(EXIT.CLI_ERROR)
      // Error message now enumerates every accepted trigger flag with an
      // example, instead of just naming them in a single line.
      expect(result.stderr).toContain('--cron')
      expect(result.stderr).toContain('--every')
      expect(result.stderr).toContain('--every-ms')
      expect(result.stderr).toContain('--webhook')
      expect(result.stderr).toContain('--at')
      expect(result.stderr).toContain('skelm schedule --help')
    } finally {
      await gw.stop()
    }
  })

  // F044 follow-up: `skelm run <path>` accepts any on-disk workflow file, but
  // `schedule add <path>` used to reject a file that lived outside the
  // registry glob with "workflow not registered" — even though the file
  // existed — leaving the schedule un-creatable. The CLI now registers such a
  // file with the gateway and schedules against the resulting registry id.
  it('add <file-path> auto-registers a workflow outside the glob and schedules it', async () => {
    const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
    // Glob discovers only project/workflows/*.workflow.mts, so the registry is
    // non-empty but hello.workflow.mts (directly under fixtures) is NOT in it.
    const gw = await startGatewayOnFreePort(stateDir, {
      projectRoot: fixtures,
      config: { registries: { workflows: { glob: 'project/workflows/**/*.workflow.mts' } } },
      loadWorkflow: true,
    })
    try {
      const helloPath = join(fixtures, 'hello.workflow.mts')
      const added = await invoke([
        'schedule',
        'add',
        helloPath,
        '--id',
        'hello-sched',
        '--cron',
        '0 * * * *',
        '--json',
      ])
      expect(added.exitCode).toBe(EXIT.OK)
      const schedule = JSON.parse(added.stdout) as { id: string; workflowId: string }
      expect(schedule.id).toBe('hello-sched')
      // Resolves to a registry id the dispatcher can later load (the path
      // relative to the CLI's cwd) rather than failing "workflow not
      // registered". The exact prefix depends on cwd; what matters is it is a
      // relative registry id, not the bare absolute path the user typed.
      expect(schedule.workflowId.endsWith('hello.workflow.mts')).toBe(true)
      expect(schedule.workflowId.startsWith('/')).toBe(false)

      // The file is now a registered workflow, so a manual fire dispatches it
      // instead of erroring "workflow not registered".
      const fired = await invoke(['schedule', 'fire', 'hello-sched'])
      expect(fired.exitCode).toBe(EXIT.OK)
    } finally {
      await gw.stop()
    }
  })

  it('add rejects an unknown id with no backing file', async () => {
    const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
    const gw = await startGatewayOnFreePort(stateDir, {
      projectRoot: fixtures,
      config: { registries: { workflows: { glob: 'project/workflows/**/*.workflow.mts' } } },
    })
    try {
      const result = await invoke(['schedule', 'add', 'no-such-workflow.ts', '--cron', '0 * * * *'])
      expect(result.exitCode).toBe(EXIT.CLI_ERROR)
      expect(result.stderr).toContain('workflow not registered')
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
async function startGatewayOnFreePort(
  stateDir: string,
  extra: { projectRoot?: string; config?: Record<string, unknown>; loadWorkflow?: boolean } = {},
): Promise<Gateway> {
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
      config: extra.config ?? {},
      ...(extra.projectRoot !== undefined && { projectRoot: extra.projectRoot }),
      ...(extra.loadWorkflow === true && {
        loadWorkflow: async (_id: string, abs: string) => await import(pathToFileURL(abs).href),
      }),
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
