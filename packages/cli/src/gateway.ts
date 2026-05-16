import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  /** For `install --systemd`. */
  systemd?: boolean
}

function defaultStateDir(): string {
  return process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm')
}

export async function gatewayCommand(args: GatewayArgs, io: MainIO): Promise<MainResult> {
  switch (args.subcommand) {
    case 'start':
      return startGateway(args, io)
    case 'status':
      return statusGateway(args, io)
    case 'stop':
      return signalGateway('SIGTERM', io)
    case 'reload':
      return signalGateway('SIGHUP', io)
    case 'pause':
    case 'resume':
      io.stderr.write(
        `gateway ${args.subcommand}: requires HTTP control surface — call POST /gateway/${args.subcommand} on the running gateway\n`,
      )
      return { exitCode: EXIT.CLI_ERROR }
    case 'install':
      return installSystemd(args, io)
    case 'uninstall':
      return uninstallSystemd(io)
  }
}

async function startGateway(args: GatewayArgs, io: MainIO): Promise<MainResult> {
  if (args.detach) {
    return detachGateway(args, io)
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

  const gateway = new Gateway({
    installSignalHandlers: true,
    enableHttp: true,
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
  const probe = new Gateway()
  const lock = await readLockfile(probe.lockfilePath)
  const disc = await readDiscovery(probe.discoveryPath)
  // A lockfile alone is not enough — if the PID is dead (kill -9, crash,
  // PID reuse) the gateway is gone. Always probe the PID before reporting
  // `running: true`. Without this, downstream CLI commands trust a stale
  // discovery URL and fail with "fetch failed".
  const pidAlive = lock !== null && isProcessAlive(lock.pid)
  const status = {
    running: lock !== null && pidAlive,
    pid: lock?.pid ?? null,
    startedAt: lock?.startedAt ?? null,
    url: disc?.url ?? null,
    ...(lock !== null && !pidAlive && { stale: true as const }),
  }
  if (args.json) {
    io.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
  } else if (status.running) {
    io.stdout.write(
      `gateway: running\n  pid: ${status.pid}\n  startedAt: ${status.startedAt}\n  url: ${status.url ?? '(unknown)'}\n`,
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

async function signalGateway(sig: 'SIGTERM' | 'SIGHUP', io: MainIO): Promise<MainResult> {
  const probe = new Gateway()
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
  const probe = new Gateway()
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

const SYSTEMD_DIR = `${process.env.HOME ?? homedir()}/.config/systemd/user`
const SYSTEMD_UNIT_PATH = `${SYSTEMD_DIR}/skelm-gateway.service`

const SYSTEMD_UNIT = `[Unit]
Description=skelm gateway
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/env skelm gateway start --foreground
ExecReload=/usr/bin/env skelm gateway reload
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

async function installSystemd(args: GatewayArgs, io: MainIO): Promise<MainResult> {
  if (!args.systemd) {
    io.stderr.write('error: gateway install requires --systemd\n')
    return { exitCode: EXIT.CLI_ERROR }
  }
  await fs.mkdir(SYSTEMD_DIR, { recursive: true })
  await fs.writeFile(SYSTEMD_UNIT_PATH, SYSTEMD_UNIT)
  io.stdout.write(
    `wrote ${SYSTEMD_UNIT_PATH}\n\nNext:\n  systemctl --user daemon-reload\n  systemctl --user enable --now skelm-gateway\n  journalctl --user -u skelm-gateway -f\n`,
  )
  // Touch defaultStateDir so PrivateTmp + ReadWritePaths land cleanly when the unit runs.
  await fs.mkdir(defaultStateDir(), { recursive: true })
  return { exitCode: EXIT.OK }
}

/**
 * Translate a pipeline-declared trigger into a full TriggerSpec. The
 * pipeline file omits `workflowId` (filled here from the registry id) and
 * may omit `id` (defaulted to `<workflowId>#<kind>[-i]`). Returns undefined
 * when the kind is unrecognized.
 */
function pipelineTriggerToSpec(
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
      }
    case 'cron':
      return { kind: 'cron', id, workflowId, cron: trigger.cron as string }
    case 'interval':
      return { kind: 'interval', id, workflowId, everyMs: trigger.everyMs as number }
    default:
      return undefined
  }
}

async function uninstallSystemd(io: MainIO): Promise<MainResult> {
  try {
    await fs.rm(SYSTEMD_UNIT_PATH)
    io.stdout.write(
      `removed ${SYSTEMD_UNIT_PATH}\n\nNext:\n  systemctl --user daemon-reload\n  systemctl --user disable skelm-gateway || true\n`,
    )
    return { exitCode: EXIT.OK }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      io.stderr.write('skelm-gateway.service not installed\n')
      return { exitCode: EXIT.CLI_ERROR }
    }
    throw err
  }
}
