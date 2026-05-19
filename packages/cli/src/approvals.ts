import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { EXIT } from './exit-codes.js'
import {
  ensureGatewayReady,
  fetchHttp,
  gatewayStateDir,
  httpError,
} from './internal/gateway-client.js'
import { writeJsonOutput } from './internal/output.js'
import type { MainIO, MainResult } from './main.js'

export interface ApprovalsArgs {
  subcommand: 'list' | 'approve' | 'deny'
  /** For approve / deny: the approval id (`<runId>:<stepId>`). */
  id?: string
  reason?: string
  approver?: string
  json?: boolean
}

export async function approvalsCommand(args: ApprovalsArgs, io: MainIO): Promise<MainResult> {
  if (args.subcommand === 'list') {
    return listApprovals(gatewayStateDir(), args, io)
  }

  const client = await ensureGatewayReady(io)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }
  const { discovery, headers } = client

  if (args.id === undefined) {
    io.stderr.write(`error: skelm approvals ${args.subcommand} requires an id\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
  const [runId, stepId] = args.id.split(':')
  if (!runId || !stepId) {
    io.stderr.write('error: id must be of the form <runId>:<stepId>\n')
    return { exitCode: EXIT.CLI_ERROR }
  }
  const url = `${discovery.url}/runs/${encodeURIComponent(runId)}/${args.subcommand}`
  const body: Record<string, string> = { stepId }
  if (args.approver !== undefined) body.approver = args.approver
  if (args.reason !== undefined) body.reason = args.reason

  const res = await fetchHttp(url, { method: 'POST', headers, body: JSON.stringify(body) }, io)
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return httpError(res, io)
  io.stdout.write(`${args.subcommand}d ${args.id}\n`)
  return { exitCode: EXIT.OK }
}

async function listApprovals(
  stateDir: string,
  args: ApprovalsArgs,
  io: MainIO,
): Promise<MainResult> {
  // The CLI reads the persisted snapshot the gateway writes on every
  // change. This works whether or not the gateway is running.
  const queuePath = join(stateDir, 'approvals.json')
  let queue: Array<{ id: string; runId: string; stepId: string; action: string }> = []
  try {
    const raw = await fs.readFile(queuePath, 'utf8')
    queue = JSON.parse(raw)
  } catch {
    // missing / empty
  }
  if (args.json) {
    writeJsonOutput(io, queue)
  } else if (queue.length === 0) {
    io.stdout.write('no pending approvals\n')
  } else {
    for (const a of queue) io.stdout.write(`${a.id}\t${a.runId}\t${a.stepId}\t${a.action}\n`)
  }
  return { exitCode: EXIT.OK }
}
