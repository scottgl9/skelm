import { EXIT } from './exit-codes.js'
import { ensureGatewayReady, fetchHttp, httpError } from './internal/gateway-client.js'
import { writeJsonOutput } from './internal/output.js'
import type { MainIO, MainResult } from './main.js'

export interface SessionsArgs {
  subcommand: 'list' | 'prune'
  expired?: boolean
  olderThanMs?: number
  json?: boolean
}

export async function sessionsCommand(args: SessionsArgs, io: MainIO): Promise<MainResult> {
  const client = await ensureGatewayReady(io)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }
  const { discovery, headers } = client

  if (args.subcommand === 'list') {
    const res = await fetchHttp(`${discovery.url}/sessions`, { headers }, io)
    if (res === null) return { exitCode: EXIT.CLI_ERROR }
    if (!res.ok) return httpError(res, io)
    const sessions = (await res.json()) as Array<{
      id: string
      agentId: string
      state: string
      lastSeenAt: string
    }>
    if (args.json) {
      writeJsonOutput(io, sessions)
    } else if (sessions.length === 0) {
      io.stdout.write('no sessions\n')
    } else {
      for (const s of sessions) {
        io.stdout.write(`${s.id}\t${s.agentId}\t${s.state}\t${s.lastSeenAt}\n`)
      }
    }
    return { exitCode: EXIT.OK }
  }

  // prune
  const body: Record<string, unknown> = {}
  if (args.expired === true) body.expired = true
  if (args.olderThanMs !== undefined) body.olderThanMs = args.olderThanMs
  const res = await fetchHttp(
    `${discovery.url}/sessions/prune`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    io,
  )
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return httpError(res, io)
  const out = (await res.json()) as { removed: string[] }
  if (args.json) {
    writeJsonOutput(io, out)
  } else {
    io.stdout.write(`pruned ${out.removed.length} session(s)\n`)
    for (const id of out.removed) io.stdout.write(`  ${id}\n`)
  }
  return { exitCode: EXIT.OK }
}
