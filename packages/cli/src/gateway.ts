import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Gateway, readDiscovery, readLockfile } from '@skelm/gateway'
import { EXIT } from './exit-codes.js'
import type { MainIO, MainResult } from './main.js'

export interface GatewayArgs {
  subcommand: 'start' | 'stop' | 'pause' | 'resume' | 'reload' | 'status' | 'install' | 'uninstall'
  foreground?: boolean
  detach?: boolean
  json?: boolean
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
    io.stderr.write(
      'gateway start --detach: spawn `nohup skelm gateway start --foreground &` from your shell, or use the systemd unit (`skelm gateway install --systemd`).\n',
    )
    return { exitCode: EXIT.CLI_ERROR }
  }
  const gateway = new Gateway({ installSignalHandlers: true })
  try {
    await gateway.start()
  } catch (err) {
    io.stderr.write(`gateway start failed: ${(err as Error).message}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }

  const discovery = gateway.getDiscovery()
  io.stdout.write(
    `skelm gateway started\n  pid: ${process.pid}\n  url: ${discovery?.url ?? '(unbound)'}\n  state-dir: ${gateway.stateDir}\n  workflows: ${gateway.registries.workflows.list().length}\n  agents:    ${gateway.registries.agents.list().length}\n`,
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
  const status = {
    running: lock !== null,
    pid: lock?.pid ?? null,
    startedAt: lock?.startedAt ?? null,
    url: disc?.url ?? null,
  }
  if (args.json) {
    io.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
  } else if (status.running) {
    io.stdout.write(
      `gateway: running\n  pid: ${status.pid}\n  startedAt: ${status.startedAt}\n  url: ${status.url ?? '(unknown)'}\n`,
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
  try {
    process.kill(lock.pid, sig)
    io.stdout.write(`sent ${sig} to pid ${lock.pid}\n`)
    return { exitCode: EXIT.OK }
  } catch (err) {
    io.stderr.write(`failed to signal pid ${lock.pid}: ${(err as Error).message}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
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
