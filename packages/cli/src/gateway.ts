import { spawn, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pickExport } from '@skelm/core'
// @subprocess-ok: re-spawning the CLI itself for `gateway start --detach`.
import {
  Gateway,
  createTriggerDispatcher,
  isProcessAlive,
  pipelineTriggerToSpec,
  readDiscovery,
  readLockfile,
} from '@skelm/gateway'
import getPort from 'get-port'
import { buildBackendRegistry } from './backends.js'
import { EXIT } from './exit-codes.js'
import { readinessHeaders } from './internal/gateway-client.js'
import type { MainIO, MainResult } from './internal/io.js'
import { writeJsonOutput } from './internal/output.js'
import { loadGatewayConfig } from './load-config.js'
import { loadWorkflowFromFile } from './load-workflow.js'

export interface GatewayArgs {
  subcommand: 'start' | 'stop' | 'pause' | 'resume' | 'reload' | 'status' | 'install' | 'uninstall'
  foreground?: boolean
  detach?: boolean
  json?: boolean
  /** Override HTTP listening port (also configurable via `server.port` in skelm.config.ts). */
  httpPort?: number
  /** Override HTTP bind host. */
  httpHost?: string
  /** Install as a systemd user service (linux). Defaults true on linux when neither flag is set. */
  systemd?: boolean
  /** Install as a launchd user agent (macOS). Defaults true on darwin when neither flag is set. */
  launchd?: boolean
  /** Explicit path to the gateway config file (skelm.gateway.ts or skelm.config.ts). */
  gatewayConfig?: string
}

function defaultStateDir(): string {
  return process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm')
}

function homeStateDir(): string {
  return join(homedir(), '.skelm')
}

const SYSTEMD_DIR = `${process.env.HOME ?? homedir()}/.config/systemd/user`
const SYSTEMD_UNIT_PATH = `${SYSTEMD_DIR}/skelm-gateway.service`
const LAUNCHD_DIR = `${process.env.HOME ?? homedir()}/Library/LaunchAgents`
const LAUNCHD_PLIST_PATH = `${LAUNCHD_DIR}/com.skelm.gateway.plist`
const LAUNCHD_LABEL = 'com.skelm.gateway'

/** Returns true if the skelm-gateway systemd unit file is installed. */
async function isSystemdInstalled(): Promise<boolean> {
  try {
    await fs.access(SYSTEMD_UNIT_PATH)
    return true
  } catch {
    return false
  }
}

/** Returns true if the skelm-gateway launchd plist is installed. */
async function isLaunchdInstalled(): Promise<boolean> {
  try {
    await fs.access(LAUNCHD_PLIST_PATH)
    return true
  } catch {
    return false
  }
}

/**
 * Run a command synchronously and return exit code + captured output.
 * Used for quick systemctl / loginctl calls.
 */
function runSync(
  cmd: string,
  args: string[],
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** Returns true if user lingering is enabled for the current user. */
function isLingeringEnabled(): boolean {
  const result = runSync('loginctl', [
    'show-user',
    process.env.USER ?? process.env.LOGNAME ?? '',
    '--property=Linger',
  ])
  return result.stdout.trim() === 'Linger=yes'
}

/** Returns true if the skelm-gateway systemd/launchd service is currently active. */
async function isServiceRunning(): Promise<boolean> {
  if (platform() === 'linux' && (await isSystemdInstalled())) {
    const result = runSync('systemctl', ['--user', 'is-active', 'skelm-gateway'])
    return result.exitCode === 0 && result.stdout.trim() === 'active'
  }
  if (platform() === 'darwin' && (await isLaunchdInstalled())) {
    const uid = process.getuid?.() ?? 0
    const result = runSync('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`])
    return result.exitCode === 0
  }
  return false
}

export async function gatewayCommand(args: GatewayArgs, io: MainIO): Promise<MainResult> {
  switch (args.subcommand) {
    case 'start':
      return startGateway(args, io)
    case 'status':
      return statusGateway(args, io)
    case 'stop':
      return stopGateway(io)
    case 'reload':
      return signalGateway('SIGHUP', io)
    case 'pause':
    case 'resume':
      io.stderr.write(
        `gateway ${args.subcommand}: requires HTTP control surface — call POST /gateway/${args.subcommand} on the running gateway\n`,
      )
      return { exitCode: EXIT.CLI_ERROR }
    case 'install':
      return installService(args, io)
    case 'uninstall':
      return uninstallService(args, io)
  }
}

/**
 * Pick the platform-default service manager. Explicit --systemd / --launchd
 * flags always win; otherwise we use the OS default (linux → systemd,
 * darwin → launchd).
 */
function pickServiceManager(args: GatewayArgs): 'systemd' | 'launchd' | null {
  if (args.systemd === true) return 'systemd'
  if (args.launchd === true) return 'launchd'
  const p = platform()
  if (p === 'linux') return 'systemd'
  if (p === 'darwin') return 'launchd'
  return null
}

async function installService(args: GatewayArgs, io: MainIO): Promise<MainResult> {
  const manager = pickServiceManager(args)
  if (manager === null) {
    io.stderr.write(
      `error: install requires --systemd (linux) or --launchd (macOS) on this platform (${platform()})\n`,
    )
    return { exitCode: EXIT.CLI_ERROR }
  }
  return manager === 'systemd' ? installSystemd(io) : installLaunchd(io)
}

async function uninstallService(args: GatewayArgs, io: MainIO): Promise<MainResult> {
  const manager = pickServiceManager(args)
  if (manager === null) {
    io.stderr.write(
      `error: uninstall requires --systemd (linux) or --launchd (macOS) on this platform (${platform()})\n`,
    )
    return { exitCode: EXIT.CLI_ERROR }
  }
  return manager === 'systemd' ? uninstallSystemd(io) : uninstallLaunchd(io)
}

/**
 * Format the success message printed when `skelm gateway start` (no
 * `--foreground`) delegates to systemctl/launchctl because a managed unit is
 * installed. Symmetry with `stopGateway`, which surfaces the delegated command
 * so operators and the s28 self-test see plainly which manager was invoked.
 * Pure + exported so the unit-test pinning the contract doesn't need to spawn
 * a real systemd user service.
 */
export function formatDelegatedStartMessage(opts: {
  manager: 'systemd' | 'launchd'
  url: string | null
  logCmd: string
}): string {
  const delegated =
    opts.manager === 'systemd'
      ? 'systemctl --user start skelm-gateway'
      : `launchctl kickstart gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`
  return `skelm gateway started (${delegated})\n  url: ${opts.url ?? '(pending)'}\n\nTo view logs:  ${opts.logCmd}\nTo stop:       skelm gateway stop\n`
}

/**
 * Guidance printed when `skelm gateway start` runs with no `--foreground` and no
 * managed unit is installed. Rather than silently running the gateway in the
 * foreground, we point the operator at the two supported ways to run it: install
 * it as a persistent background service, or run it inline with --foreground.
 * Pure + exported so a unit test can pin the contract without spawning anything.
 */
export function formatStartGuidanceMessage(opts: { canInstall: boolean }): string {
  const lines = [
    'skelm gateway start does not run the gateway on its own. Choose how to run it:',
    '',
  ]
  if (opts.canInstall) {
    lines.push(
      '  • Install it as a persistent background service (recommended):',
      '      skelm gateway install',
      '',
    )
  }
  lines.push(
    '  • Run it in the foreground (Ctrl-C to stop):',
    '      skelm gateway start --foreground',
    '',
  )
  return `${lines.join('\n')}\n`
}

async function startGateway(args: GatewayArgs, io: MainIO): Promise<MainResult> {
  if (args.detach) {
    return detachGateway(args, io)
  }

  // If a managed service unit is installed, delegate to the platform's
  // service manager so the gateway runs supervised in the background.
  // Skip this when --foreground is explicitly requested.
  if (!args.foreground) {
    const systemdInstalled = platform() === 'linux' && (await isSystemdInstalled())
    const launchdInstalled = platform() === 'darwin' && (await isLaunchdInstalled())
    if (systemdInstalled || launchdInstalled) {
      // First check if the service is already active/running
      const isAlreadyRunning = await isServiceRunning()
      if (isAlreadyRunning) {
        // Service is already running, just report success
        const probe = new Gateway({ stateDir: defaultStateDir() })
        const disc = await readDiscovery(probe.discoveryPath)
        const logCmd = systemdInstalled
          ? 'journalctl --user -u skelm-gateway -f'
          : `tail -f ${defaultStateDir()}/gateway.log`
        io.stdout.write(
          `skelm gateway already active (background service)\n  url: ${disc?.url ?? '(pending)'}\n\nTo view logs:  ${logCmd}\nTo stop:       skelm gateway stop\n`,
        )
        return { exitCode: EXIT.OK }
      }

      const cmd = systemdInstalled
        ? { bin: 'systemctl', args: ['--user', 'start', 'skelm-gateway'], hint: 'systemctl' }
        : (() => {
            const uid = process.getuid?.() ?? 0
            return {
              bin: 'launchctl',
              args: ['kickstart', `gui/${uid}/${LAUNCHD_LABEL}`],
              hint: 'launchctl',
            }
          })()
      const result = runSync(cmd.bin, cmd.args)
      if (result.exitCode === 0) {
        const probe = new Gateway({ stateDir: defaultStateDir() })
        // systemctl --user start returns as soon as the start job is queued.
        // The unit may still be "activating" when our process resumes, which
        // confuses both operators and tooling that immediately probes
        // `is-active`. Wait for the unit to report `active` (bounded) AND
        // for discovery to appear before returning, so the success message
        // truly means "the gateway is ready". 15s is generous enough for
        // cold starts on machines with a large audit log / many workflows;
        // override with SKELM_GATEWAY_READY_TIMEOUT_MS for slower hosts.
        const readyTimeoutMs = (() => {
          const raw = process.env.SKELM_GATEWAY_READY_TIMEOUT_MS
          const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
          return Number.isFinite(n) && n > 0 ? n : 15_000
        })()
        const deadline = Date.now() + readyTimeoutMs
        if (systemdInstalled) {
          while (Date.now() < deadline) {
            const active = runSync('systemctl', ['--user', 'is-active', 'skelm-gateway'])
            if (active.exitCode === 0 && active.stdout.trim() === 'active') break
            await new Promise((r) => setTimeout(r, 100))
          }
        }
        let disc = await readDiscovery(probe.discoveryPath)
        while (disc === null && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100))
          disc = await readDiscovery(probe.discoveryPath)
        }
        const logCmd = systemdInstalled
          ? 'journalctl --user -u skelm-gateway -f'
          : `tail -f ${defaultStateDir()}/gateway.log`
        io.stdout.write(
          formatDelegatedStartMessage({
            manager: systemdInstalled ? 'systemd' : 'launchd',
            url: disc?.url ?? null,
            logCmd,
          }),
        )
        return { exitCode: EXIT.OK }
      }
      io.stderr.write(
        `warning: ${cmd.hint} start failed (${result.stderr.trim()}); starting in foreground instead.\n\n`,
      )
    } else {
      // No managed unit installed and no --foreground: don't silently run in the
      // foreground. Point the operator at install (persistent service) or
      // --foreground (run inline), then exit.
      io.stdout.write(
        formatStartGuidanceMessage({
          canInstall: platform() === 'linux' || platform() === 'darwin',
        }),
      )
      return { exitCode: EXIT.OK }
    }
  }

  // Load gateway config. Precedence: --gateway-config flag → SKELM_GATEWAY_CONFIG
  // env → ~/.skelm/skelm.gateway.* → cwd walkup → defaults.
  const { config } = await loadGatewayConfig(
    args.gatewayConfig !== undefined ? { fromPath: args.gatewayConfig } : undefined,
  )
  const serverCfg = config.server ?? {}
  // CLI flags (--http-port / --http-host) win over skelm.config.ts.
  const httpPort = args.httpPort ?? serverCfg.port
  const httpHost = args.httpHost ?? serverCfg.host

  // Loader used by both the trigger dispatcher AND the HTTP /pipelines/:id/run
  // path (so invoke() steps and `POST /pipelines/<id>/run` can resolve
  // workflow modules). Without this on the Gateway constructor, HTTP /run
  // returns 501 and invoke() targets fail with "pipeline not found".
  // Use loadWorkflowFromFile so out-of-tree workflows (e.g. /tmp/) get the
  // transient node_modules symlink that lets them resolve 'skelm' / '@skelm/*'.
  const loadWorkflow = (_id: string, absolutePath: string): Promise<unknown> =>
    loadWorkflowFromFile(absolutePath).then((p) => ({ default: p }))

  // F043: SKELM_STATE_DIR env override must thread through to the Gateway
  // constructor; without an explicit option the constructor falls back to
  // `homedir() + '/.skelm'`, ignoring the operator's isolation choice.
  //
  // `syncDeclared` is wired as the Gateway's onReload hook so that a
  // POST /gateway/reload re-walks pipelines[*].triggers and registers any
  // newly-declared trigger (issue #164) — and sweeps declared trigger
  // registrations whose backing workflow file is gone (issue #162). The
  // closure captures `gateway` by reference so it's safe to declare here
  // before the construction completes.
  // Build the backend registry BEFORE constructing the Gateway so it can be
  // passed into GatewayOptions. The registry covers BOTH `config.instances`
  // (pre-built backends like vercel-ai / opencode SDK / pi) AND
  // `config.backends.<id>` factory entries (Pi RPC, opencode subprocess, …).
  // Without it, runs that reference a config-backed backend id (e.g.
  // `agent({ backend: 'pi' })`) — regardless of whether they were fired
  // via a trigger or via HTTP /pipelines/run-file — fail with
  // BackendNotFoundError.
  const backendRegistry = await buildBackendRegistry(config)

  let gateway: Gateway
  const syncDeclared = async (): Promise<void> => {
    if (gateway === undefined) return
    await syncDeclaredTriggers(gateway, io)
  }
  gateway = new Gateway({
    // The CLI owns process signals in foreground mode (see the SIGTERM/SIGINT/
    // SIGHUP handlers below). If the gateway installed its own handlers too,
    // SIGTERM would fire both — the gateway's stop() and the CLI's stop() race,
    // the second concurrent drain errors on already-closed resources, and the
    // gateway's handler force-exits 1 instead of the clean 0 a graceful
    // shutdown should produce.
    installSignalHandlers: false,
    enableHttp: true,
    stateDir: defaultStateDir(),
    ...(httpPort !== undefined && { httpPort }),
    ...(httpHost !== undefined && { httpHost }),
    config,
    loadWorkflow,
    onReload: syncDeclared,
    ...(backendRegistry !== undefined && { backends: backendRegistry }),
  })
  installCrashHandlers(gateway, io)
  try {
    await gateway.start()
  } catch (err) {
    io.stderr.write(`gateway start failed: ${(err as Error).message}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }

  // Replace the trigger coordinator's onFire with the real dispatcher.
  const dispatcher = createTriggerDispatcher({
    gateway,
    loadWorkflow,
    ...(backendRegistry !== undefined && { backends: backendRegistry }),
  })
  gateway.managers.triggers.setOnFire(dispatcher)

  // Register config-declared trigger sources (Telegram, Slack, etc.) as
  // queue drivers. Pipelines reference these by `sourceId` in their
  // `triggers: [{ kind: 'queue', sourceId }]` declarations.
  for (const entry of config.triggerSources ?? []) {
    gateway.managers.triggers.registerQueueDriver(entry.id, entry.driver)
  }

  // Eagerly import each registered workflow once at startup so its
  // declared `triggers` are wired through the coordinator. The same helper
  // is invoked as Gateway.onReload so `POST /gateway/reload` picks up
  // newly-declared triggers (issue #164) and sweeps orphan registrations
  // for workflow files that were deleted (issue #162).
  const declaredCount = await syncDeclaredTriggers(gateway, io)

  const discovery = gateway.getDiscovery()
  io.stdout.write(
    `skelm gateway started\n  pid: ${process.pid}\n  url: ${discovery?.url ?? '(unbound)'}\n  state-dir: ${gateway.stateDir}\n  workflows: ${gateway.registries.workflows.list().length}\n  agents:    ${gateway.registries.agents.list().length}\n  triggers:  ${declaredCount}\n`,
  )

  // SIGHUP drives a live reload so `skelm gateway reload` keeps working now
  // that the gateway no longer installs its own signal handlers. reload()
  // runs the onReload hook (syncDeclared) wired at construction.
  const onReloadSignal = (): void => {
    void gateway.reload().catch((err: unknown) => {
      io.stderr.write(`gateway reload failed: ${(err as Error).message}\n`)
    })
  }
  process.on('SIGHUP', onReloadSignal)
  await new Promise<void>((resolve) => {
    const onStop = () => resolve()
    process.once('SIGTERM', onStop)
    process.once('SIGINT', onStop)
  })
  process.off('SIGHUP', onReloadSignal)
  await gateway.stop()
  io.stdout.write('skelm gateway stopped\n')
  return { exitCode: EXIT.OK }
}

const CRASH_SHUTDOWN_GRACE_MS = 5_000
let crashHandlersInstalled = false

/**
 * Install last-line unhandledRejection / uncaughtException handlers on the
 * current process. Logs the error, attempts a bounded gateway drain, then
 * forces exit(1) so supervisors observe the failure. `exitFn` is injectable
 * for tests; default is `process.exit`.
 */
export function installCrashHandlers(
  gateway: Pick<Gateway, 'stop'>,
  io: MainIO,
  exitFn: (code: number) => void = (code) => process.exit(code),
): void {
  if (crashHandlersInstalled) return
  crashHandlersInstalled = true
  const handle = (kind: 'unhandledRejection' | 'uncaughtException', err: unknown): void => {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    io.stderr.write(`gateway ${kind}: ${msg}\n`)
    const forceExit = setTimeout(() => exitFn(1), CRASH_SHUTDOWN_GRACE_MS).unref()
    gateway
      .stop()
      .catch((stopErr) => {
        io.stderr.write(`gateway stop failed during ${kind}: ${(stopErr as Error).message}\n`)
      })
      .finally(() => {
        clearTimeout(forceExit)
        exitFn(1)
      })
  }
  process.on('unhandledRejection', (reason) => handle('unhandledRejection', reason))
  process.on('uncaughtException', (err) => handle('uncaughtException', err))
}

/** Test-only: reset the install-once flag so a second test invocation works. */
export function __resetCrashHandlersForTest(): void {
  crashHandlersInstalled = false
  process.removeAllListeners('unhandledRejection')
  process.removeAllListeners('uncaughtException')
}

async function statusGateway(args: GatewayArgs, io: MainIO): Promise<MainResult> {
  const probe = new Gateway({ stateDir: defaultStateDir() })
  const lock = await readLockfile(probe.lockfilePath)
  const disc = await readDiscovery(probe.discoveryPath)
  // A lockfile alone is not enough — if the PID is dead (kill -9, crash,
  // PID reuse) the gateway is gone. Always probe the PID before reporting
  // `running: true`. Without this, downstream CLI commands trust a stale
  // discovery URL and fail with "fetch failed".
  const pidAlive = lock !== null && isProcessAlive(lock.pid)
  const isRunning = lock !== null && pidAlive

  // Probe HTTP reachability if the gateway appears to be running.
  let reachable: boolean | null = null
  if (isRunning && disc?.url) {
    reachable = await probeGatewayUrl(disc.url)
  }

  const status = {
    running: isRunning,
    pid: lock?.pid ?? null,
    startedAt: lock?.startedAt ?? null,
    url: disc?.url ?? null,
    reachable,
    ...(lock !== null && !pidAlive && { stale: true as const }),
  }

  if (args.json) {
    writeJsonOutput(io, status)
  } else if (isRunning) {
    const reachableStr =
      reachable === true
        ? 'yes'
        : reachable === false
          ? 'no (port may not be bound yet)'
          : 'unknown'
    io.stdout.write(
      `gateway: running\n  pid: ${status.pid}\n  startedAt: ${status.startedAt}\n  url: ${status.url ?? '(unknown)'}\n  reachable: ${reachableStr}\n`,
    )
  } else if (lock !== null && !pidAlive) {
    io.stdout.write(
      `gateway: not running (stale lockfile — pid ${lock.pid} is dead; will be reclaimed on next 'skelm gateway start')\n`,
    )
  } else {
    io.stdout.write('gateway: not running\n')
  }
  return { exitCode: EXIT.OK }
}

/**
 * Probe the gateway's HTTP URL to verify it is reachable and the port is
 * bound. Returns true if any HTTP response is received (any status code),
 * false if the connection is refused or times out.
 */
async function probeGatewayUrl(url: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3_000)
    try {
      await fetch(url, { signal: controller.signal, method: 'GET' })
      return true
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    return false
  }
}

/**
 * Stop the gateway. If the systemd unit is installed and the service is
 * active, delegate to `systemctl --user stop` so systemd tracks the state
 * correctly. Otherwise, send SIGTERM to the PID from the lockfile.
 *
 * Returns exit 0 even when the gateway is not running (idempotent behavior).
 */
async function stopGateway(io: MainIO): Promise<MainResult> {
  const probe = new Gateway({ stateDir: defaultStateDir() })
  const lock = await readLockfile(probe.lockfilePath)

  // If nothing is running at all, say so clearly but return success.
  if (lock === null || !isProcessAlive(lock.pid)) {
    if (lock !== null) {
      io.stdout.write(
        `gateway: not running (stale lockfile — pid ${lock.pid} is dead; will be reclaimed on next 'skelm gateway start')\n`,
      )
    } else {
      io.stdout.write('gateway: not running\n')
    }
    return { exitCode: EXIT.OK }
  }

  // If a managed service is installed, prefer the service manager's stop
  // command so its bookkeeping stays in sync and it won't auto-restart.
  if (platform() === 'linux' && (await isSystemdInstalled())) {
    const result = runSync('systemctl', ['--user', 'stop', 'skelm-gateway'])
    if (result.exitCode === 0) {
      io.stdout.write('skelm gateway stopped (systemctl --user stop skelm-gateway)\n')
      return { exitCode: EXIT.OK }
    }
    io.stderr.write(`systemctl stop failed (${result.stderr.trim()}); falling back to SIGTERM\n`)
  } else if (platform() === 'darwin' && (await isLaunchdInstalled())) {
    const uid = process.getuid?.() ?? 0
    const result = runSync('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`])
    if (result.exitCode === 0) {
      io.stdout.write('skelm gateway stopped (via launchd)\n')
      return { exitCode: EXIT.OK }
    }
    io.stderr.write(`launchctl bootout failed (${result.stderr.trim()}); falling back to SIGTERM\n`)
  }

  try {
    process.kill(lock.pid, 'SIGTERM')
    io.stdout.write(`sent SIGTERM to pid ${lock.pid}\n`)
    return { exitCode: EXIT.OK }
  } catch (err) {
    io.stderr.write(`failed to signal pid ${lock.pid}: ${(err as Error).message}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
}

async function signalGateway(sig: 'SIGTERM' | 'SIGHUP', io: MainIO): Promise<MainResult> {
  const probe = new Gateway({ stateDir: defaultStateDir() })
  const lock = await readLockfile(probe.lockfilePath)
  if (lock === null) {
    io.stdout.write('gateway: not running\n')
    return { exitCode: EXIT.OK }
  }
  if (!isProcessAlive(lock.pid)) {
    io.stdout.write(
      `gateway: not running (stale lockfile — pid ${lock.pid} is dead; will be reclaimed on next 'skelm gateway start')\n`,
    )
    return { exitCode: EXIT.OK }
  }
  try {
    process.kill(lock.pid, sig)
    io.stdout.write(`sent ${sig} to pid ${lock.pid}\n`)
    return { exitCode: EXIT.OK }
  } catch (err) {
    io.stderr.write(`failed to signal pid ${lock.pid}: ${(err as Error).message}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
}

/**
 * Spawn ourselves in the background and exit, leaving the gateway running
 * as a detached process. Mirrors what `nohup skelm gateway start &` would
 * do, but builds it into the CLI so users don't have to know the recipe.
 *
 * We re-exec via `process.execPath` + the resolved bin script, *without*
 * `--detach` (otherwise infinite recursion), preserving `--http-port` /
 * `--http-host` overrides so the child binds where the parent intended.
 */
async function detachGateway(args: GatewayArgs, io: MainIO): Promise<MainResult> {
  // The detached child must run the gateway inline; bare `gateway start` now
  // prints guidance and exits, so pass --foreground explicitly.
  const argv = [process.argv[1] ?? 'skelm', 'gateway', 'start', '--foreground']
  const stateDir = defaultStateDir()
  const httpPort =
    args.httpPort ??
    (stateDir !== homeStateDir() ? await getPort({ host: '127.0.0.1', reserve: true }) : undefined)
  if (httpPort !== undefined) argv.push('--http-port', String(httpPort))
  if (args.httpHost !== undefined) argv.push('--http-host', args.httpHost)
  if (args.gatewayConfig !== undefined) argv.push('--gateway-config', args.gatewayConfig)
  // Ensure SKELM_STATE_DIR is passed to the child process
  const childEnv = { ...process.env }
  if (process.env.SKELM_STATE_DIR) {
    childEnv.SKELM_STATE_DIR = process.env.SKELM_STATE_DIR
  }
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: 'ignore',
    env: childEnv,
  })
  child.unref()
  // Give the child a moment to become request-ready, so the success message
  // means follow-up CLI commands can actually use this state dir's gateway.
  const probe = new Gateway({ stateDir })
  const readyTimeoutMs = (() => {
    const raw = process.env.SKELM_GATEWAY_READY_TIMEOUT_MS
    const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : 8_000
  })()
  const deadline = Date.now() + readyTimeoutMs
  while (Date.now() < deadline) {
    const lock = await readLockfile(probe.lockfilePath)
    // Don't assert lock.pid === child.pid: on some platforms the spawned
    // wrapper process forks once more before exec, so the gateway's actual
    // pid differs from the spawn() return value. Accept any live lock.
    if (lock !== null && isProcessAlive(lock.pid)) {
      const disc = await readDiscovery(probe.discoveryPath)
      if (disc !== null) {
        try {
          const controller = new AbortController()
          const tid = setTimeout(() => controller.abort(), 1_000)
          try {
            const res = await fetch(`${disc.url}/readyz`, {
              headers: readinessHeaders(disc),
              signal: controller.signal,
            })
            if (res.ok) {
              io.stdout.write(
                `skelm gateway started (detached)\n  pid: ${lock.pid}\n  url: ${disc.url}\n`,
              )
              return { exitCode: EXIT.OK }
            }
          } finally {
            clearTimeout(tid)
          }
        } catch {
          // lock/discovery exist, but HTTP is not accepting requests yet
        }
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  io.stderr.write(
    `gateway start --detach: gateway did not become ready within ${readyTimeoutMs}ms. Inspect logs via journalctl or rerun in foreground.\n`,
  )
  return { exitCode: EXIT.CLI_ERROR }
}

/**
 * Build the systemd unit body, embedding absolute paths to the current node
 * binary and skelm CLI entrypoint. systemd-user services run with a minimal
 * PATH (`/usr/local/bin:/usr/bin:/bin`) that does NOT include npm-global bins,
 * nvm shims, or local `node_modules/.bin`, so a unit relying on `/usr/bin/env
 * skelm` crash-loops with status 127 whenever skelm isn't on that minimal
 * PATH. Using absolute paths makes the unit self-contained.
 */
export function buildSystemdUnit(): string {
  const nodePath = process.execPath
  const skelmBin = process.argv[1] ?? ''
  if (!skelmBin) {
    throw new Error('cannot determine skelm bin path (process.argv[1] is empty)')
  }
  return `[Unit]
Description=skelm gateway
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${skelmBin} gateway start --foreground
ExecReload=${nodePath} ${skelmBin} gateway reload
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5s
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=%h/.skelm %h/.config/skelm
NoNewPrivileges=true

[Install]
WantedBy=default.target
`
}

/**
 * Install and start the skelm gateway as a systemd user service.
 *
 * Steps:
 *  1. Write the unit file to ~/.config/systemd/user/skelm-gateway.service
 *  2. daemon-reload
 *  3. enable --now (starts immediately + enables on login)
 *  4. Warn if user lingering is not enabled (service won't survive logout)
 */
async function installSystemd(io: MainIO): Promise<MainResult> {
  // Fail loudly if the unit file can't be written — otherwise the later
  // `systemctl enable` fails with a confusing "Unit file does not exist"
  // and the operator can't tell the write never happened.
  try {
    await fs.mkdir(SYSTEMD_DIR, { recursive: true })
    await fs.writeFile(SYSTEMD_UNIT_PATH, buildSystemdUnit())
  } catch (err) {
    io.stderr.write(
      `error: failed to write systemd unit ${SYSTEMD_UNIT_PATH}\n  ${(err as Error).message}\n`,
    )
    return { exitCode: EXIT.CLI_ERROR }
  }
  io.stdout.write(`wrote ${SYSTEMD_UNIT_PATH}\n`)

  // Touch defaultStateDir so PrivateTmp + ReadWritePaths land cleanly when the unit runs.
  await fs.mkdir(defaultStateDir(), { recursive: true })

  // Reload systemd so it picks up the new unit.
  const reload = runSync('systemctl', ['--user', 'daemon-reload'])
  if (reload.exitCode !== 0) {
    io.stderr.write(
      'warning: systemctl daemon-reload failed — you may need to run it manually:\n  systemctl --user daemon-reload\n',
    )
  }

  // Enable and start the service.
  const enable = runSync('systemctl', ['--user', 'enable', '--now', 'skelm-gateway'])
  if (enable.exitCode !== 0) {
    const errMsg = enable.stderr.trim()
    io.stderr.write(`error: failed to enable/start skelm-gateway service\n  ${errMsg}\n\n`)

    // Check if this is a lingering/D-Bus issue.
    const isLingerIssue =
      errMsg.includes('linger') ||
      errMsg.includes('D-Bus') ||
      errMsg.includes('dbus') ||
      errMsg.includes('No such file or directory') ||
      errMsg.includes('connect to bus')

    if (isLingerIssue) {
      io.stderr.write(
        `hint: user lingering may not be enabled. Lingering allows user services to\nstart at boot and survive without an active login session. Enable it with:\n\n  loginctl enable-linger ${process.env.USER ?? process.env.LOGNAME ?? '$USER'}\n\nThen re-run: skelm gateway install\n`,
      )
    } else {
      io.stderr.write(
        'To start manually: systemctl --user enable --now skelm-gateway\n' +
          'To view logs:      journalctl --user -u skelm-gateway -f\n',
      )
    }
    return { exitCode: EXIT.CLI_ERROR }
  }

  io.stdout.write('skelm gateway service installed and started\n')

  // Warn about lingering if not enabled — service won't survive user logout.
  if (!isLingeringEnabled()) {
    io.stdout.write(
      `\nwarning: user lingering is not enabled. The gateway will stop when you log out\nand will not start automatically at boot. To fix this:\n\n  loginctl enable-linger ${process.env.USER ?? process.env.LOGNAME ?? '$USER'}\n`,
    )
  }

  io.stdout.write(
    '\nTo view logs:  journalctl --user -u skelm-gateway -f\nTo stop:       skelm gateway stop\nTo uninstall:  skelm gateway uninstall\n',
  )
  return { exitCode: EXIT.OK }
}

/**
 * Walk the workflow registry, import each module, and reconcile its
 * declared `triggers:` array with the coordinator's current registrations.
 * On the boot path this is the first registration; on reload it is a
 * three-way reconcile:
 *
 * - **add** triggers whose registration id is not yet present
 * - **replace** triggers whose spec changed since the last sync (so
 *   editing `cron`, `tz`, `path`, `every`, `clientState`, etc. on a
 *   live workflow actually takes effect — partial fix for issue #164)
 * - **remove** declared registrations whose backing workflow file
 *   disappeared from the registry OR whose pipeline still exists but no
 *   longer declares that trigger id (full fix for issue #162 and the
 *   "shrunk triggers: array" half of #164)
 *
 * `POST /schedules` registrations are preserved unconditionally — they
 * are identified by the absence of `reg.declared`, not by id-string
 * heuristics, so an operator schedule named `nightly#backup` is safe.
 *
 * Returns the count of currently-armed declared triggers. Failures on a
 * single workflow are logged to stderr and don't stop the sync.
 */
export async function syncDeclaredTriggers(gateway: Gateway, io: MainIO): Promise<number> {
  const liveWorkflowIds = new Set<string>()
  // Capture the set of declared-trigger ids we end up registering this
  // pass, keyed by spec id. After the loop, any existing declared reg not
  // in this set is removed — that's how we detect "trigger removed from a
  // still-live workflow" and "trigger array shrunk".
  const expectedDeclaredIds = new Set<string>()
  const armedIds = new Set<string>()

  for (const entry of gateway.registries.workflows.list()) {
    liveWorkflowIds.add(entry.id)
    try {
      // Cache-bust the ESM import by the file's mtime. A workflow whose
      // `triggers:` array is edited IN PLACE (same path) would otherwise return
      // the STALE cached module on reload — so an added/changed declared trigger
      // is never registered (a brand-new file imports fresh and works; a mutated
      // existing file did not — issue #164's "trigger added to a live workflow"
      // half). Unchanged files keep the same mtime → same URL → cached (no
      // re-import cost on a no-op reload).
      // INTEGER mtime (Math.trunc): a fractional value like `…789.077` makes
      // esbuild/vitest read the trailing `.077` as a file extension ("Invalid
      // loader value"). Truncating keeps the query a plain integer.
      const mtimeMs = Math.trunc((await fs.stat(entry.path)).mtimeMs)
      const mod = (await import(`${pathToFileURL(entry.path).href}?mtime=${mtimeMs}`)) as Record<
        string,
        unknown
      >

      // `pickExport` strips the `{ default: { default: <value> } }` wrap
      // Node 22+ produces under CJS interop. Without it, workflows
      // without top-level imports (or test fixtures) silently produce
      // zero declared triggers instead of registering correctly.
      // Both pipelines and persistent workflows expose a `triggers` array, so
      // trigger discovery is agnostic to which kind the module exported.
      const exported = pickExport(mod, 'default') as
        | { triggers?: readonly Record<string, unknown>[] }
        | undefined
      const triggers = exported?.triggers ?? []
      for (const [i, t] of triggers.entries()) {
        const spec = pipelineTriggerToSpec(entry.id, t, i)
        if (spec === undefined) {
          // ms-graph without clientState is a refused configuration, not an
          // unknown kind — name it specifically so the pipeline author can
          // fix it instead of hunting for a typo (issue #161 default-deny).
          const reason =
            t.kind === 'webhook' && t.provider === 'ms-graph'
              ? `ms-graph webhook requires a non-empty 'clientState' (Graph does not sign payloads)`
              : 'unknown trigger kind'
          io.stderr.write(`gateway: workflow ${entry.id} trigger ${i} skipped: ${reason}\n`)
          continue
        }
        expectedDeclaredIds.add(spec.id)
        const existing = gateway.managers.triggers.get(spec.id)
        if (existing !== undefined) {
          // Spec drift: the operator edited the workflow file (changed
          // cron expression, file path, clientState, etc.). The old reg
          // is still holding stale resources — replace it.
          if (specsEqual(existing.spec, spec)) {
            armedIds.add(spec.id)
            continue
          }
          gateway.managers.triggers.unregister(spec.id)
        }
        const reg = gateway.managers.triggers.register(spec, undefined, {
          ...(t.input !== undefined && { input: t.input }),
          declared: true,
        })
        if (reg.lastError !== undefined) {
          io.stderr.write(
            `gateway: failed to register trigger ${spec.id} for ${entry.id}: ${reg.lastError}\n`,
          )
        } else {
          armedIds.add(spec.id)
        }
      }
    } catch (err) {
      io.stderr.write(
        `gateway: failed to load workflow ${entry.id} for trigger discovery: ${(err as Error).message}\n`,
      )
    }
  }

  // Sweep:
  //   - workflow file deleted ⇒ workflowId no longer in liveWorkflowIds
  //   - trigger removed from a still-live workflow ⇒ workflowId is live
  //     but spec id is not in expectedDeclaredIds
  // Only declared registrations are eligible; operator-managed schedules
  // (declared !== true) are preserved unconditionally so a manual schedule
  // named like `nightly#backup` is not silently destroyed (issue #162
  // followup; replaces the previous `id.includes('#')` heuristic).
  for (const reg of gateway.managers.triggers.list()) {
    if (reg.declared !== true) continue
    if (liveWorkflowIds.has(reg.spec.workflowId) && expectedDeclaredIds.has(reg.spec.id)) continue
    gateway.managers.triggers.unregister(reg.spec.id)
  }
  return armedIds.size
}

/**
 * Structural equality on two TriggerSpecs. The `id` and `workflowId`
 * fields are by construction equal when this is called (callers compare
 * an existing reg's spec against a freshly-built spec for the same
 * triggers[i] position) — drift in any other field means the operator
 * edited the workflow and the old reg should be torn down.
 *
 * Limitation: `JSON.stringify` drops functions, so edits to the body of
 * an `event-source: 'custom'` `start` callback are NOT detected as drift
 * on reload. Operators changing a custom start function should restart
 * the gateway (or remove + re-add the workflow file) to pick it up.
 */
function specsEqual(
  a: import('@skelm/gateway').TriggerSpec,
  b: import('@skelm/gateway').TriggerSpec,
): boolean {
  if (a.kind !== b.kind) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

async function uninstallSystemd(io: MainIO): Promise<MainResult> {
  // Stop the service first if it's running.
  const stopResult = runSync('systemctl', ['--user', 'stop', 'skelm-gateway'])
  if (stopResult.exitCode === 0) {
    runSync('systemctl', ['--user', 'disable', 'skelm-gateway'])
  }

  try {
    await fs.rm(SYSTEMD_UNIT_PATH)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      io.stderr.write('skelm-gateway.service not installed\n')
      return { exitCode: EXIT.CLI_ERROR }
    }
    throw err
  }

  runSync('systemctl', ['--user', 'daemon-reload'])
  io.stdout.write('skelm gateway service uninstalled\n')
  return { exitCode: EXIT.OK }
}

/**
 * Build the launchd plist body. Mirrors the systemd unit in spirit:
 * absolute paths so the agent doesn't depend on the launchd PATH (which
 * is restrictive and would not find a `nvm`/`fnm`-managed node), foreground
 * start so launchd owns the process lifecycle, and KeepAlive on crash.
 */
export function buildLaunchdPlist(): string {
  const nodePath = process.execPath
  const skelmBin = process.argv[1] ?? ''
  if (!skelmBin) {
    throw new Error('cannot determine skelm bin path (process.argv[1] is empty)')
  }
  const stateDir = defaultStateDir()
  const logPath = `${stateDir}/gateway.log`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${skelmBin}</string>
    <string>gateway</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`
}

async function installLaunchd(io: MainIO): Promise<MainResult> {
  try {
    await fs.mkdir(LAUNCHD_DIR, { recursive: true })
    await fs.writeFile(LAUNCHD_PLIST_PATH, buildLaunchdPlist())
  } catch (err) {
    io.stderr.write(
      `error: failed to write launchd plist ${LAUNCHD_PLIST_PATH}\n  ${(err as Error).message}\n`,
    )
    return { exitCode: EXIT.CLI_ERROR }
  }
  io.stdout.write(`wrote ${LAUNCHD_PLIST_PATH}\n`)

  await fs.mkdir(defaultStateDir(), { recursive: true })

  const uid = process.getuid?.() ?? 0
  const domain = `gui/${uid}`
  // bootstrap loads the plist into the user's GUI domain; if already loaded
  // we bootout first so a re-install replaces the running instance cleanly.
  const existing = runSync('launchctl', ['print', `${domain}/${LAUNCHD_LABEL}`])
  if (existing.exitCode === 0) {
    runSync('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`])
  }
  const bootstrap = runSync('launchctl', ['bootstrap', domain, LAUNCHD_PLIST_PATH])
  if (bootstrap.exitCode !== 0) {
    io.stderr.write(
      `error: failed to bootstrap launchd agent\n  ${bootstrap.stderr.trim()}\n\nTo start manually:\n  launchctl bootstrap ${domain} ${LAUNCHD_PLIST_PATH}\n  launchctl kickstart ${domain}/${LAUNCHD_LABEL}\n`,
    )
    return { exitCode: EXIT.CLI_ERROR }
  }
  // kickstart explicitly so RunAtLoad doesn't have to be relied upon.
  runSync('launchctl', ['kickstart', `${domain}/${LAUNCHD_LABEL}`])

  io.stdout.write(
    `skelm gateway agent installed and started\n\nTo view logs:  tail -f ${defaultStateDir()}/gateway.log\nTo stop:       skelm gateway stop\nTo uninstall:  skelm gateway uninstall --launchd\n`,
  )
  return { exitCode: EXIT.OK }
}

async function uninstallLaunchd(io: MainIO): Promise<MainResult> {
  const uid = process.getuid?.() ?? 0
  const domain = `gui/${uid}`
  const bootout = runSync('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`])
  // launchctl returns non-zero when the agent isn't loaded (exit code 3
  // on macOS for "No such process"). That's fine — we still want to
  // remove the plist — but surface the message so the operator knows
  // what happened, matching the systemd path's logging style.
  if (bootout.exitCode !== 0) {
    const detail =
      (bootout.stderr || bootout.stdout || '').trim() || `exit code ${bootout.exitCode}`
    io.stderr.write(`warning: launchctl bootout ${domain}/${LAUNCHD_LABEL}: ${detail}\n`)
  }
  try {
    await fs.rm(LAUNCHD_PLIST_PATH)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      io.stderr.write(`${LAUNCHD_PLIST_PATH} not installed\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    throw err
  }
  io.stdout.write('skelm gateway launchd agent uninstalled\n')
  return { exitCode: EXIT.OK }
}
