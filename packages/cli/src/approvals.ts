import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readDiscovery } from '@skelm/gateway'
import { EXIT } from './exit-codes.js'
import type { MainIO, MainResult } from './main.js'

export interface ApprovalsArgs {
  subcommand: 'list' | 'approve' | 'deny'
  id?: string
  reason?: string
  json?: boolean
}

/**
 * Phase 6 placeholder CLI. Reaches the running gateway via the HTTP
 * control surface in Phase 11; for now reads the gateway discovery file
 * and reports a friendly error if the surface isn't wired yet.
 */
export async function approvalsCommand(args: ApprovalsArgs, io: MainIO): Promise<MainResult> {
  const stateDir = process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm')
  const discovery = await readDiscovery(join(stateDir, 'gateway.json'))

  if (discovery === null) {
    io.stderr.write('error: gateway is not running — start it with `skelm gateway start`\n')
    return { exitCode: EXIT.CLI_ERROR }
  }

  // The HTTP approval endpoints land in Phase 11 alongside the rest of the
  // remote control surface. Until then, expose the queue file the gateway
  // writes (a JSON snapshot of the in-memory SuspendApprovalGate).
  const queuePath = join(stateDir, 'approvals.json')
  let queue: Array<{ id: string; runId: string; stepId: string; action: string }> = []
  try {
    const raw = await fs.readFile(queuePath, 'utf8')
    queue = JSON.parse(raw)
  } catch {
    /* missing file → empty queue */
  }

  if (args.subcommand === 'list') {
    if (args.json) {
      io.stdout.write(`${JSON.stringify(queue, null, 2)}\n`)
    } else if (queue.length === 0) {
      io.stdout.write('no pending approvals\n')
    } else {
      for (const a of queue) {
        io.stdout.write(`${a.id}\t${a.runId}\t${a.stepId}\t${a.action}\n`)
      }
    }
    return { exitCode: EXIT.OK }
  }

  io.stderr.write(
    `gateway HTTP approval surface lands in Phase 11 — ${args.subcommand} not yet wired remotely\n`,
  )
  return { exitCode: EXIT.CLI_ERROR }
}
