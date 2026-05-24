import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Gateway } from '@skelm/gateway'

async function acquireEphemeralPort(): Promise<number> {
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

async function isPortBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true))
    })
  })
}

/**
 * Pick an ephemeral port and verify it's still bindable. CI runs many
 * vitest files in parallel, so the OS-assigned port from a freshly closed
 * socket is occasionally already grabbed by a sibling test by the time we
 * try to bind. A few retries collapse the race window to ~microseconds.
 */
async function pickFreePort(retries = 5): Promise<number> {
  let lastErr: unknown
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const candidate = await acquireEphemeralPort()
      if (await isPortBindable(candidate)) return candidate
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`pickFreePort: exhausted ${retries} retries (last: ${String(lastErr)})`)
}

export interface InProcessGateway {
  stateDir: string
  url: string
  gw: Gateway
  /** Stops the gateway and removes the temp state dir. */
  stop(): Promise<void>
}

/**
 * Boot a gateway in-process for a CLI test. Writes a discovery file under
 * a fresh tmp SKELM_STATE_DIR so the CLI's `requireGateway()` picks it up
 * without auto-starting another one.
 *
 * The loader uses the real Node ESM import so any workflow file the test
 * points at (e.g. examples/hello/hello.workflow.mts) loads exactly as it
 * does in production.
 */
export interface BootOptions {
  /** Point the gateway at a specific project root so its workflow registry
   * discovers workflows there. */
  projectRoot?: string
  /** Pass through extra gateway config (registries, defaults, etc.). */
  config?: Record<string, unknown>
}

export async function bootInProcessGateway(options: BootOptions = {}): Promise<InProcessGateway> {
  const stateDir = await mkdtemp(join(tmpdir(), 'skelm-cli-gw-harness-'))
  process.env.SKELM_STATE_DIR = stateDir
  process.env.SKELM_NO_AUTOSTART = '1'
  // Multiple vitest workers run in parallel — the OS-assigned ephemeral
  // port from pickFreePort is occasionally grabbed by a sibling worker
  // between port-pick and gateway-bind. Retry the whole boot a few times
  // so the harness is robust to that race.
  let lastErr: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await pickFreePort()
    const gw = new Gateway({
      stateDir,
      enableHttp: true,
      httpPort: port,
      installSignalHandlers: false,
      loadWorkflow: async (_id, absolutePath) => import(pathToFileURL(absolutePath).href),
      ...(options.projectRoot !== undefined && {
        projectRoot: options.projectRoot,
        watchRegistries: false,
      }),
      ...(options.config !== undefined && { config: options.config as never }),
    })
    try {
      await gw.start()
      return finalize(gw, stateDir)
    } catch (err) {
      lastErr = err
      try {
        await gw.stop()
      } catch {
        // ignore
      }
      if (!/EADDRINUSE/.test(String((err as Error)?.message ?? err))) throw err
    }
  }
  throw new Error(`bootInProcessGateway: exhausted retries (${String(lastErr)})`)
}

async function finalize(gw: Gateway, stateDir: string): Promise<InProcessGateway> {
  const disc = gw.getDiscovery()
  if (disc === null) throw new Error('gateway did not write discovery on start')
  // The lifecycle.start() already wrote ~/.skelm/gateway.json into stateDir,
  // but tests sometimes need the raw URL. Re-assert it explicitly so a
  // missing discovery file fails fast rather than appearing as a CLI timeout.
  await writeFile(
    join(stateDir, 'gateway.json'),
    JSON.stringify(
      { pid: process.pid, url: disc.url, startedAt: new Date().toISOString() },
      null,
      2,
    ),
  )
  return {
    stateDir,
    url: disc.url,
    gw,
    async stop() {
      await gw.stop()
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}
