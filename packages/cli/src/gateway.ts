import { Gateway, readDiscovery, readLockfile } from '@skelm/gateway'
import { EXIT } from './exit-codes.js'
import type { MainIO, MainResult } from './main.js'

export interface GatewayArgs {
  subcommand: 'start' | 'stop' | 'pause' | 'resume' | 'reload' | 'status'
  foreground?: boolean
  detach?: boolean
  json?: boolean
}

/**
 * Phase 2 implementation. Only `start --foreground`, `stop`, and `status`
 * have meaningful behaviour against an in-process gateway. The remote-control
 * verbs (pause/resume/reload + the detached form of start/stop) land in
 * Phase 11 once an HTTP control surface is wired in.
 */
export async function gatewayCommand(args: GatewayArgs, io: MainIO): Promise<MainResult> {
  switch (args.subcommand) {
    case 'start':
      return startGateway(args, io)
    case 'status':
      return statusGateway(args, io)
    case 'stop':
    case 'pause':
    case 'resume':
    case 'reload':
      io.stderr.write(
        `gateway ${args.subcommand}: requires running gateway control surface (Phase 11)\n`,
      )
      return { exitCode: EXIT.CLI_ERROR }
  }
}

async function startGateway(args: GatewayArgs, io: MainIO): Promise<MainResult> {
  if (args.detach) {
    io.stderr.write('gateway start --detach is not yet implemented (Phase 11)\n')
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
    `skelm gateway started\n  pid: ${process.pid}\n  url: ${discovery?.url ?? '(unbound)'}\n  state-dir: ${gateway.stateDir}\n`,
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
