import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readDiscovery } from '@skelm/gateway'
import { EXIT } from './exit-codes.js'
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
  const stateDir = process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm')
  const discovery = await readDiscovery(join(stateDir, 'gateway.json'))

  if (args.subcommand === 'list') {
    return listApprovals(stateDir, args, io)
  }

  if (discovery === null) {
    io.stderr.write('error: gateway is not running — start it with `skelm gateway start`\n')
    return { exitCode: EXIT.CLI_ERROR }
  }
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
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (discovery.token !== undefined) headers.authorization = `Bearer ${discovery.token}`
  const body: Record<string, string> = { stepId }
  if (args.approver !== undefined) body.approver = args.approver
  if (args.reason !== undefined) body.reason = args.reason

  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch (err) {
    io.stderr.write(`error: gateway HTTP request failed: ${(err as Error).message}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
  if (!res.ok) {
    io.stderr.write(`error: gateway returned ${res.status}: ${await res.text()}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
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
    io.stdout.write(`${JSON.stringify(queue, null, 2)}\n`)
  } else if (queue.length === 0) {
    io.stdout.write('no pending approvals\n')
  } else {
    for (const a of queue) io.stdout.write(`${a.id}\t${a.runId}\t${a.stepId}\t${a.action}\n`)
  }
  return { exitCode: EXIT.OK }
}
