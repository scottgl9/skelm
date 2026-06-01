import { spawn, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { type DiscoveryRecord, readDiscovery } from '@skelm/gateway'
import { EXIT } from '../exit-codes.js'
import type { MainIO, MainResult } from './io.js'

export interface GatewayClient {
  discovery: DiscoveryRecord
  headers: Record<string, string>
  stateDir: string
}

export type ServiceManager = 'systemd' | 'launchd' | 'none'

export function gatewayStateDir(): string {
  return process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm')
}

/** The default state dir (`~/.skelm`), used when SKELM_STATE_DIR is unset. */
export function defaultStateDir(): string {
  return join(homedir(), '.skelm')
}

/**
 * Ask the OS for a free TCP port (bind to :0, read the assigned port, release).
 * Used so an auto-started gateway for a NON-default state dir binds a port that
 * won't collide with the conventional shared gateway's fixed port.
 */
export async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo | null
      const port = addr?.port ?? 0
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

export async function loadDiscovery(stateDir?: string): Promise<DiscoveryRecord | null> {
  const dir = stateDir ?? gatewayStateDir()
  return readDiscovery(join(dir, 'gateway.json'))
}

/** Default per-request timeout: long enough for cold-start runs, short
 *  enough that a wedged gateway doesn't hang the CLI forever. */
const DEFAULT_CLI_FETCH_TIMEOUT_MS = 30_000

/** Detect which user-level service manager is appropriate for this host. */
export function detectServiceManager(): ServiceManager {
  const plat = platform()
  if (plat === 'darwin') return 'launchd'
  if (plat === 'linux') return 'systemd'
  return 'none'
}

const SYSTEMD_UNIT_PATH = join(
  process.env.HOME ?? homedir(),
  '.config/systemd/user/skelm-gateway.service',
)
const LAUNCHD_PLIST_PATH = join(
  process.env.HOME ?? homedir(),
  'Library/LaunchAgents/com.skelm.gateway.plist',
)

/** Returns true if the manager's unit/plist file exists for skelm-gateway. */
export async function isServiceInstalled(manager: ServiceManager): Promise<boolean> {
  const path =
    manager === 'systemd' ? SYSTEMD_UNIT_PATH : manager === 'launchd' ? LAUNCHD_PLIST_PATH : null
  if (path === null) return false
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Poll `~/.skelm/gateway.json` + GET `/readyz` until the gateway is
 * accepting requests or the deadline expires. Returns a discovery record
 * on success, null on timeout.
 */
export async function waitForReady(
  stateDir: string,
  timeoutMs?: number,
): Promise<DiscoveryRecord | null> {
  // Resolution order: explicit arg > SKELM_GATEWAY_READY_TIMEOUT_MS env >
  // 15s default. Cold/slow machines (or first-run installations that
  // pull deps) can need longer than 15s.
  const envOverride = process.env.SKELM_GATEWAY_READY_TIMEOUT_MS
  const resolved =
    timeoutMs ??
    (envOverride !== undefined && /^\d+$/.test(envOverride) ? Number(envOverride) : 15_000)
  const deadline = Date.now() + resolved
  while (Date.now() < deadline) {
    const disc = await readDiscovery(join(stateDir, 'gateway.json'))
    if (disc !== null) {
      try {
        const controller = new AbortController()
        const tid = setTimeout(() => controller.abort(), 2_000)
        try {
          const res = await fetch(`${disc.url}/readyz`, { signal: controller.signal })
          if (res.ok) return disc
        } finally {
          clearTimeout(tid)
        }
      } catch {
        // not ready yet; keep polling
      }
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return null
}

/**
 * Where the one-time auto-start hint marker lives. Once present, the hint
 * is not repeated on subsequent auto-starts (the operator has seen it).
 */
function autostartHintMarkerPath(): string {
  return join(gatewayStateDir(), '.autostart-hint-shown')
}

async function emitAutostartHintOnce(manager: ServiceManager, io: MainIO): Promise<void> {
  const path = autostartHintMarkerPath()
  try {
    await fs.access(path)
    return
  } catch {
    // marker missing — emit hint
  }
  const installCmd =
    manager === 'launchd'
      ? '`skelm gateway install --launchd`'
      : manager === 'systemd'
        ? '`skelm gateway install --systemd`'
        : '`skelm gateway install`'
  io.stderr.write(
    `note: started gateway ad-hoc in the background. For a supervised service that survives reboots, run ${installCmd}.\n`,
  )
  try {
    await fs.mkdir(gatewayStateDir(), { recursive: true })
    await fs.writeFile(path, new Date().toISOString())
  } catch {
    // best-effort; we'd rather show the hint twice than fail the run
  }
}

/**
 * Run a quick subprocess and capture exit code + stdout/stderr. Used for
 * `systemctl` / `launchctl` invocations during auto-start.
 */
// @subprocess-ok: invoking the system service manager to start an already-installed skelm-gateway unit.
function runSyncCapture(
  cmd: string,
  args: string[],
): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/**
 * Auto-start the gateway when no live discovery is found:
 *   - If the platform's service manager is installed AND the skelm unit/plist
 *     exists, ask the manager to start it.
 *   - Otherwise spawn `skelm gateway start` as a detached background process
 *     and print a one-time hint suggesting the operator install it as a
 *     supervised service.
 * Honors `SKELM_NO_AUTOSTART=1` (returns null without trying anything).
 * Refuses to auto-spawn in CI unless `SKELM_AUTOSTART_IN_CI=1`.
 */
export async function autoStartGateway(io: MainIO): Promise<DiscoveryRecord | null> {
  if (process.env.SKELM_NO_AUTOSTART === '1') return null
  if (process.env.CI === 'true' && process.env.SKELM_AUTOSTART_IN_CI !== '1') {
    io.stderr.write(
      'error: gateway is not running and auto-start is disabled in CI (set SKELM_AUTOSTART_IN_CI=1 to override, or start it explicitly with `skelm gateway start --foreground &`).\n',
    )
    return null
  }
  const stateDir = gatewayStateDir()
  const manager = detectServiceManager()
  const serviceInstalled = await isServiceInstalled(manager)

  if (serviceInstalled && manager === 'systemd') {
    runSyncCapture('systemctl', ['--user', 'start', 'skelm-gateway'])
  } else if (serviceInstalled && manager === 'launchd') {
    // `kickstart -k` (re)starts the agent, restarting it if it's already running.
    const uid = process.getuid?.() ?? 0
    runSyncCapture('launchctl', ['kickstart', '-k', `gui/${uid}/com.skelm.gateway`])
  } else {
    // No service installed — spawn the CLI itself as a detached background
    // process. The child's argv[0]/argv[1] mirror the parent's so it
    // re-execs the same skelm binary.
    // The detached child must run the gateway inline; bare `gateway start` now
    // prints guidance and exits, so pass --foreground explicitly.
    const argv = [process.argv[1] ?? 'skelm', 'gateway', 'start', '--foreground']
    // An ad-hoc gateway for a NON-default SKELM_STATE_DIR must not collide with
    // the conventional shared gateway (or another state dir's gateway) on the
    // config's fixed port: the child inherits SKELM_STATE_DIR (so its lockfile
    // and gateway.json are state-dir-scoped) but, without an explicit port,
    // would still bind config.server.port (e.g. 14738). Two state dirs then
    // race for the same port — the loser fails with "did not become ready",
    // and a stale gateway.json can point a command at the WRONG gateway's data.
    // Bind a free port instead; the CLI discovers the real URL from the state
    // dir's gateway.json, so the port need not be well-known. The default state
    // dir keeps config.server.port so the conventional shared gateway is intact.
    if (stateDir !== defaultStateDir()) {
      try {
        const port = await findFreePort()
        argv.push('--http-port', String(port))
      } catch {
        // Couldn't grab a free port — fall back to the config port and let the
        // readiness check surface any collision as before.
      }
    }
    const child = spawn(process.execPath, argv, {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.unref()
    await emitAutostartHintOnce(manager, io)
  }

  const disc = await waitForReady(stateDir)
  if (disc === null) {
    io.stderr.write(
      'error: gateway did not become ready within the configured timeout. Check `skelm gateway status` or the logs at ~/.skelm/gateway.log. Set SKELM_GATEWAY_READY_TIMEOUT_MS to override the default (15000).\n',
    )
    return null
  }
  return disc
}

/**
 * Return a client pointed at a running gateway. If none is up, refuses
 * unless auto-start succeeds. Use this for any CLI command that requires
 * the gateway to actually do work.
 */
/**
 * Build a discovery record from `SKELM_GATEWAY_URL` when it is set, letting a
 * caller target an already-running gateway by URL instead of by state-dir
 * discovery file. `SKELM_GATEWAY_TOKEN` supplies the bearer token for a
 * gateway that requires auth. Returns null when the env var is unset or blank.
 */
export function discoveryFromEnvUrl(): DiscoveryRecord | null {
  const url = process.env.SKELM_GATEWAY_URL?.trim()
  if (url === undefined || url === '') return null
  const token = process.env.SKELM_GATEWAY_TOKEN?.trim()
  return {
    pid: -1,
    url: url.replace(/\/+$/, ''),
    ...(token !== undefined && token !== '' && { token }),
    startedAt: new Date().toISOString(),
  }
}

export async function requireGateway(io: MainIO): Promise<GatewayClient | null> {
  const stateDir = gatewayStateDir()
  // An explicit SKELM_GATEWAY_URL points the CLI at a specific running gateway
  // by URL — bypassing the state-dir discovery file and never auto-starting a
  // local one. This is how callers address a gateway they did not start
  // themselves (a remote service, or a fixture on a known port).
  const fromUrl = discoveryFromEnvUrl()
  if (fromUrl !== null) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (fromUrl.token !== undefined) headers.authorization = `Bearer ${fromUrl.token}`
    return { discovery: fromUrl, headers, stateDir }
  }
  let discovery = await loadDiscovery(stateDir)
  if (discovery === null) {
    discovery = await autoStartGateway(io)
    if (discovery === null) {
      if (process.env.SKELM_NO_AUTOSTART === '1') {
        io.stderr.write(
          'error: gateway is not running and SKELM_NO_AUTOSTART=1. Start it with `skelm gateway start`.\n',
        )
      }
      return null
    }
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (discovery.token !== undefined) headers.authorization = `Bearer ${discovery.token}`
  return { discovery, headers, stateDir }
}

export async function fetchHttp(
  url: string,
  init: RequestInit | undefined,
  io: MainIO,
  timeoutMs: number = DEFAULT_CLI_FETCH_TIMEOUT_MS,
): Promise<Response | null> {
  try {
    const merged: RequestInit = {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    }
    return await fetch(url, merged)
  } catch (err) {
    io.stderr.write(`error: gateway HTTP request failed: ${(err as Error).message}\n`)
    return null
  }
}

export async function httpError(res: Response, io: MainIO): Promise<MainResult> {
  io.stderr.write(`error: gateway returned ${res.status}: ${await res.text()}\n`)
  return { exitCode: EXIT.CLI_ERROR }
}

/**
 * Parsed Server-Sent Events. Each iterator value carries the decoded JSON
 * data (when the event body parses as JSON; otherwise the raw text), the
 * SSE event type, and the optional `id:` for `Last-Event-ID` resume.
 */
export interface SseEvent {
  event: string
  id: string | undefined
  data: unknown
  raw: string
}

/**
 * Open an SSE connection and yield parsed events. Closes when the server
 * ends the stream or the caller aborts via `signal`. Reconnect-on-drop is
 * NOT automatic — callers that need it should track the last `id` and
 * re-invoke with `Last-Event-ID`.
 */
export async function* openSse(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, unknown> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...headers, accept: 'text/event-stream' },
    ...(signal !== undefined && { signal }),
  })
  if (!res.ok || res.body === null) {
    throw new Error(`SSE GET ${url} failed: ${res.status} ${res.statusText}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE event boundary is a blank line.
      let sepIdx = buffer.indexOf('\n\n')
      while (sepIdx !== -1) {
        const frame = buffer.slice(0, sepIdx)
        buffer = buffer.slice(sepIdx + 2)
        const ev = parseSseFrame(frame)
        if (ev !== null) yield ev
        sepIdx = buffer.indexOf('\n\n')
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

function parseSseFrame(frame: string): SseEvent | null {
  let event = 'message'
  let id: string | undefined
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let val = colon === -1 ? '' : line.slice(colon + 1)
    if (val.startsWith(' ')) val = val.slice(1)
    if (field === 'event') event = val
    else if (field === 'id') id = val
    else if (field === 'data') dataLines.push(val)
  }
  if (dataLines.length === 0 && event === 'message') return null
  const raw = dataLines.join('\n')
  let data: unknown = raw
  if (raw !== '') {
    try {
      data = JSON.parse(raw)
    } catch {
      // leave as raw string
    }
  }
  return { event, id, data, raw }
}
