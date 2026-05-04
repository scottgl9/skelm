import { homedir } from 'node:os'
import { join } from 'node:path'
import { readDiscovery } from '@skelm/gateway'
import { EXIT } from './exit-codes.js'
import type { MainIO, MainResult } from './main.js'

export interface SessionsArgs {
  subcommand: 'list' | 'prune'
  expired?: boolean
  olderThanMs?: number
  json?: boolean
}

export async function sessionsCommand(args: SessionsArgs, io: MainIO): Promise<MainResult> {
  const stateDir = process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm')
  const discovery = await readDiscovery(join(stateDir, 'gateway.json'))
  if (discovery === null) {
    io.stderr.write('error: gateway is not running — start it with `skelm gateway start`\n')
    return { exitCode: EXIT.CLI_ERROR }
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (discovery.token !== undefined) headers.authorization = `Bearer ${discovery.token}`

  if (args.subcommand === 'list') {
    let res: Response
    try {
      res = await fetch(`${discovery.url}/sessions`, { headers })
    } catch (err) {
      io.stderr.write(`error: gateway HTTP request failed: ${(err as Error).message}\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    if (!res.ok) {
      io.stderr.write(`error: gateway returned ${res.status}: ${await res.text()}\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    const sessions = (await res.json()) as Array<{
      id: string
      agentId: string
      state: string
      lastSeenAt: string
    }>
    if (args.json) {
      io.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`)
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
  let res: Response
  try {
    res = await fetch(`${discovery.url}/sessions/prune`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  } catch (err) {
    io.stderr.write(`error: gateway HTTP request failed: ${(err as Error).message}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
  if (!res.ok) {
    io.stderr.write(`error: gateway returned ${res.status}: ${await res.text()}\n`)
    return { exitCode: EXIT.CLI_ERROR }
  }
  const out = (await res.json()) as { removed: string[] }
  if (args.json) {
    io.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  } else {
    io.stdout.write(`pruned ${out.removed.length} session(s)\n`)
    for (const id of out.removed) io.stdout.write(`  ${id}\n`)
  }
  return { exitCode: EXIT.OK }
}
