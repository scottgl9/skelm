import { spawn, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDuration } from '@skelm/core'
// @subprocess-ok: re-spawning the CLI itself for `gateway start --detach`.
import {
  Gateway,
  createTriggerDispatcher,
  isProcessAlive,
  readDiscovery,
  readLockfile,
} from '@skelm/gateway'
import { tsImport } from 'tsx/esm/api'
import { buildBackendRegistry } from './backends.js'
import { EXIT } from './exit-codes.js'
import { loadSkelmConfig } from './load-config.js'
import type { MainIO, MainResult } from './main.js'

export interface GatewayArgs {
  subcommand: 'start' | 'stop' | 'pause' | 'resume' | 'reload' | 'status' | 'install' | 'uninstall'
  foreground?: boolean
  detach?: boolean
  json?: boolean
  /** Override HTTP listening port (also configurable via `server.port` in skelm.config.ts). */
  httpPort?: number
  /** Override HTTP bind host. */
  httpHost?: string
  /** @deprecated Kept for backwards compatibility — `gateway install` no longer requires this flag. */
  systemd?: boolean
}

function defaultStateDir(): string {
  return process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm')
}

const SYSTEMD_DIR = `${process.env.HOME ?? homedir()}/.config/systemd/user`
const SYSTEMD_UNIT_PATH = `${SYSTEMD_DIR}/skelm-gateway.service`

/** Returns true if the skelm-gateway systemd unit file is installed. */
async function isSystemdInstalled(): Promise<boolean> {
  try {
    await fs.access(SYSTEMD_UNIT_PATH)
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
      return installSystemd(io)
    case 'uninstall':
      return uninstallSystemd(io)
  }
}

async function startGateway(args: GatewayArgs, io: MainIO): Promise<MainResult> {
  if (args.detach) {
    return detachGateway(args, io)
  }

  // If the systemd unit is installed, delegate to `systemctl --user start`
  // so the service runs in the background under systemd supervision.
  // Skip this when --foreground is explicitly requested.
  if (!args.foreground) {
    const installed = await isSystemdInstalled()
    if (installed) {
      const result = runSync('systemctl', ['--user', 'start', 'skelm-gateway'])
      if (result.exitCode === 0) {
        // Wait briefly for the gateway to write its discovery file.
        const probe = new Gateway({ stateDir: defaultStateDir() })
        const deadline = Date.now() + 5_000
        let disc = await readDiscovery(probe.discoveryPath)
        while (disc === null && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100))
          disc = await readDiscovery(probe.discoveryPath)
        }
        io.stdout.write(
          `skelm gateway started (background service)\n  url: ${disc?.url ?? '(pending)'}\n\nTo view logs:  journalctl --user -u skelm-gateway -f\nTo stop:       skelm gateway stop\n`,
        )
        return { exitCode: EXIT.OK }
      }
      // systemctl failed — fall through to foreground start and report the error.
      io.stderr.write(
        `warning: systemctl start failed (${result.stderr.trim()}); starting in foreground instead.\n\n`,
      )
    } else {
      io.stderr.write(
        'tip: run `skelm gateway install` to install the gateway as a persistent background service.\n\n',
      )
    }
  }

  // Load skelm.config.ts from cwd (walking up). Config drives port, host,
  // registry globs, and default permissions.
  const { config } = await loadSkelmConfig({ fromDir: process.cwd() })
  const serverCfg = config.server ?? {}
  // CLI flags (--http-port / --http-host) win over skelm.config.ts.
  const httpPort = args.httpPort ?? serverCfg.port
  const httpHost = args.httpHost ?? serverCfg.host

  // Loader used by both the trigger dispatcher AND the HTTP /pipelines/:id/run
  // path (so invoke() steps and `POST /pipelines/<id>/run` can resolve
  // workflow modules). Without this on the Gateway constructor, HTTP /run
  // returns 501 and invoke() targets fail with "pipeline not found".
  const loadWorkflow = async (_id: string, absolutePath: string): Promise<unknown> =>
    tsImport(pathToFileURL(absolutePath).href, import.meta.url)

  // F043: SKELM_STATE_DIR env override must thread through to the Gateway
  // constructor; without an explicit option the constructor falls back to
  // `homedir() + '/.skelm'`, ignoring the operator's isolation choice.
  const gateway = new Gateway({
    installSignalHandlers: true,
    enableHttp: true,
    stateDir: defaultStateDir(),
    ...(httpPort !== undefined && { httpPort }),
    ...(httpHost !== undefined && { httpHost }),
    config,
    loadWorkflow,
  })
  try {
    await gateway.start()
  } catch (err) {
    io.stderr.write(`gateway start failed: ${(err as Error).message}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }

  // Build a backend registry covering BOTH `config.instances` (pre-built
  // backends like vercel-ai / opencode SDK / pi-sdk) AND `config.backends.<id>`
  // factory entries (Pi RPC, opencode subprocess, …). Without the latter,
  // gateway-fired runs that reference a config-backed backend id (e.g.
  // `agent({ backend: 'pi' })`) fail with `BackendNotFoundError`.
  const backendRegistry = await buildBackendRegistry(config)

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
  // declared `triggers` can be wired through the coordinator. Failures on
  // a single workflow are logged and don't block boot.
  let declaredCount = 0
  for (const entry of gateway.registries.workflows.list()) {
    try {
      const mod = (await tsImport(pathToFileURL(entry.path).href, import.meta.url)) as {
        default?: { triggers?: readonly Record<string, unknown>[] }
      }
      const triggers = mod.default?.triggers ?? []
      for (const [i, t] of triggers.entries()) {
        const spec = pipelineTriggerToSpec(entry.id, t, i)
        if (spec === undefined) {
          io.stderr.write(
            `gateway: workflow ${entry.id} declares an unknown trigger kind, skipping\n`,
          )
          continue
        }
        // Pipeline-declared triggers may include an `input` field that the
        // gateway uses as the default pipeline input on cron/interval/manual
        // fires. Pass it through to the coordinator so `triggers: [{ kind:
        // 'cron', cron: '…', input: { foo: 'bar' } }]` works.
        const reg = gateway.managers.triggers.register(
          spec,
          undefined,
          t.input !== undefined ? { input: t.input } : {},
        )
        if (reg.lastError !== undefined) {
          io.stderr.write(
            `gateway: failed to register trigger ${spec.id} for ${entry.id}: ${reg.lastError}\n`,
          )
        } else {
          declaredCount++
        }
      }
    } catch (err) {
      io.stderr.write(
        `gateway: failed to load workflow ${entry.id} for trigger discovery: ${(err as Error).message}\n`,
      )
    }
  }

  const discovery = gateway.getDiscovery()
  io.stdout.write(
    `skelm gateway started\n  pid: ${process.pid}\n  url: ${discovery?.url ?? '(unbound)'}\n  state-dir: ${gateway.stateDir}\n  workflows: ${gateway.registries.workflows.list().length}\n  agents:    ${gateway.registries.agents.list().length}\n  triggers:  ${declaredCount}\n`,
  )

  await new Promise<void>((resolve) => {
    const onStop = () => resolve()
    process.once('SIGTERM', onStop)
    process.once('SIGINT', onStop)
  })
  await gateway.stop()
  io.stdout.write('skelm gateway stopped\n')
  return { exitCode: EXIT.OK }
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
    io.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
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
 */
async function stopGateway(io: MainIO): Promise<MainResult> {
  const probe = new Gateway({ stateDir: defaultStateDir() })
  const lock = await readLockfile(probe.lockfilePath)

  // If nothing is running at all, say so clearly.
  if (lock === null || !isProcessAlive(lock.pid)) {
    if (lock !== null) {
      io.stderr.write(
        `gateway: not running (stale lockfile — pid ${lock.pid} is dead; will be reclaimed on next 'skelm gateway start')\n`,
      )
    } else {
      io.stderr.write('gateway: not running\n')
    }
    return { exitCode: EXIT.CLI_ERROR }
  }

  // If the systemd unit is installed, prefer `systemctl stop` so systemd
  // stays in sync and won't auto-restart the process.
  if (await isSystemdInstalled()) {
    const result = runSync('systemctl', ['--user', 'stop', 'skelm-gateway'])
    if (result.exitCode === 0) {
      io.stdout.write('skelm gateway stopped (via systemd)\n')
      return { exitCode: EXIT.OK }
    }
    // Fall through to direct SIGTERM if systemctl failed for some reason
    // (e.g. the unit is installed but the service isn't currently tracked).
    io.stderr.write(`systemctl stop failed (${result.stderr.trim()}); falling back to SIGTERM\n`)
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
    io.stderr.write('gateway: not running\n')
    return { exitCode: EXIT.CLI_ERROR }
  }
  if (!isProcessAlive(lock.pid)) {
    io.stderr.write(
      `gateway: not running (stale lockfile — pid ${lock.pid} is dead; will be reclaimed on next 'skelm gateway start')\n`,
    )
    return { exitCode: EXIT.CLI_ERROR }
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
  const argv = [process.argv[1] ?? 'skelm', 'gateway', 'start']
  if (args.httpPort !== undefined) argv.push('--http-port', String(args.httpPort))
  if (args.httpHost !== undefined) argv.push('--http-host', args.httpHost)
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  // Give the child a moment to acquire the lockfile and write discovery, so
  // a follow-up `skelm gateway status` (the typical next step) doesn't race
  // ahead of it. Bounded poll, not a fixed sleep.
  const probe = new Gateway({ stateDir: defaultStateDir() })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const lock = await readLockfile(probe.lockfilePath)
    if (lock !== null && lock.pid === child.pid && isProcessAlive(lock.pid)) {
      const disc = await readDiscovery(probe.discoveryPath)
      io.stdout.write(
        `skelm gateway started (detached)\n  pid: ${lock.pid}\n  url: ${disc?.url ?? '(pending)'}\n`,
      )
      return { exitCode: EXIT.OK }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  io.stderr.write(
    `gateway start --detach: child pid ${child.pid} did not acquire lockfile within 5s. Inspect logs via journalctl or rerun in foreground.\n`,
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
  await fs.mkdir(SYSTEMD_DIR, { recursive: true })
  await fs.writeFile(SYSTEMD_UNIT_PATH, buildSystemdUnit())
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
 * Translate a pipeline-declared trigger into a full TriggerSpec. The
 * pipeline file omits `workflowId` (filled here from the registry id) and
 * may omit `id` (defaulted to `<workflowId>#<kind>[-i]`). Returns undefined
 * when the kind is unrecognized.
 */
export function pipelineTriggerToSpec(
  workflowId: string,
  trigger: Record<string, unknown>,
  index: number,
): import('@skelm/gateway').TriggerSpec | undefined {
  const kind = trigger.kind as string | undefined
  const explicitId = typeof trigger.id === 'string' ? trigger.id : undefined
  const defaultId = `${workflowId}#${kind ?? 'trigger'}${index === 0 ? '' : `-${index}`}`
  const id = explicitId ?? defaultId
  switch (kind) {
    case 'queue':
      return {
        kind: 'queue',
        id,
        workflowId,
        driver: trigger.sourceId as string,
        ...(trigger.config !== undefined && {
          config: trigger.config as Record<string, unknown>,
        }),
      }
    case 'webhook':
      return {
        kind: 'webhook',
        id,
        workflowId,
        path: trigger.path as string,
        ...(trigger.method !== undefined && { method: trigger.method as string }),
        ...(trigger.secret !== undefined && { secret: trigger.secret as string }),
        // Without forwarding `dedupe`, every pipeline-declared webhook ran
        // without idempotency; same delivery id dispatched twice. The
        // coordinator + HTTP route both honor the field once the spec
        // carries it.
        ...(trigger.dedupe !== undefined && {
          dedupe: trigger.dedupe as { header: string; ttlMs?: number },
        }),
      }
    case 'cron': {
      const tz = typeof trigger.tz === 'string' ? trigger.tz : undefined
      return {
        kind: 'cron',
        id,
        workflowId,
        cron: trigger.cron as string,
        ...(tz !== undefined && { tz }),
      }
    }
    case 'interval': {
      const everyMsRaw = trigger.everyMs
      const everyRaw = trigger.every
      const everyMs =
        typeof everyMsRaw === 'number'
          ? everyMsRaw
          : typeof everyRaw === 'string'
            ? parseDuration(everyRaw)
            : undefined
      if (everyMs === undefined) return undefined
      return {
        kind: 'interval',
        id,
        workflowId,
        everyMs,
        ...(typeof everyRaw === 'string' && { every: everyRaw }),
      }
    }
    case 'github-pr':
      // The github-pr primitive (commit e08f167) is sugar over a webhook
      // trigger with GitHub-Delivery dedupe pre-configured. Translate here
      // so a pipeline can declare it without manually wiring
      // registerGitHubPrTrigger() from @skelm/integrations.
      //
      // Per-event filtering (events/filter.dropBotAuthors/filter.repos) and
      // payload normalization to GitHubPrPayload are still the pipeline's
      // responsibility — the first step should call
      // `normalizeGitHubPrEvent(headers['x-github-event'], body, spec)`
      // from `@skelm/integrations`. Until a kind-aware pre-dispatch hook
      // lands on TriggerCoordinator, the run input is the raw
      // `{body, headers, path, method, deliveredAt}` envelope produced by
      // the underlying webhook trigger.
      return {
        kind: 'webhook',
        id,
        workflowId,
        path: trigger.path as string,
        method: 'POST',
        ...(trigger.secret !== undefined && { secret: trigger.secret as string }),
        dedupe: {
          header: 'X-GitHub-Delivery',
          ttlMs: (trigger.dedupeTtlMs as number | undefined) ?? 24 * 60 * 60 * 1000,
        },
      }
    default:
      return undefined
  }
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
