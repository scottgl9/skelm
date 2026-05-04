import { homedir } from 'node:os'
import { join } from 'node:path'
import { readDiscovery } from '@skelm/gateway'
import { EXIT } from './exit-codes.js'
import type { MainIO, MainResult } from './main.js'

export interface DebugArgs {
  subcommand: 'breakpoints' | 'add' | 'remove' | 'runs' | 'release'
  /** For add / remove: the step id. For release: the run id. */
  arg?: string
  json?: boolean
}

export async function debugCommand(args: DebugArgs, io: MainIO): Promise<MainResult> {
  const stateDir = process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm')
  const discovery = await readDiscovery(join(stateDir, 'gateway.json'))
  if (discovery === null) {
    io.stderr.write('error: gateway is not running — start it with `skelm gateway start`\n')
    return { exitCode: EXIT.CLI_ERROR }
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (discovery.token !== undefined) headers.authorization = `Bearer ${discovery.token}`

  switch (args.subcommand) {
    case 'breakpoints': {
      const res = await fetchHttp(`${discovery.url}/debug/breakpoints`, { headers })
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return httpError(res, io)
      const body = (await res.json()) as { breakpoints: string[] }
      if (args.json) {
        io.stdout.write(`${JSON.stringify(body.breakpoints, null, 2)}\n`)
      } else if (body.breakpoints.length === 0) {
        io.stdout.write('no breakpoints set\n')
      } else {
        for (const id of body.breakpoints) io.stdout.write(`${id}\n`)
      }
      return { exitCode: EXIT.OK }
    }
    case 'add': {
      if (!args.arg) {
        io.stderr.write('error: skelm debug add requires a step id\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
      const res = await fetchHttp(`${discovery.url}/debug/breakpoints`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ stepId: args.arg }),
      })
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return httpError(res, io)
      io.stdout.write(`added ${args.arg}\n`)
      return { exitCode: EXIT.OK }
    }
    case 'remove': {
      if (!args.arg) {
        io.stderr.write('error: skelm debug remove requires a step id\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
      const res = await fetchHttp(
        `${discovery.url}/debug/breakpoints/${encodeURIComponent(args.arg)}`,
        { method: 'DELETE', headers },
      )
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return httpError(res, io)
      io.stdout.write(`removed ${args.arg}\n`)
      return { exitCode: EXIT.OK }
    }
    case 'runs': {
      const res = await fetchHttp(`${discovery.url}/debug/runs`, { headers })
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return httpError(res, io)
      const body = (await res.json()) as {
        paused: Array<{ runId: string; stepId: string; kind: string; at: number }>
      }
      if (args.json) {
        io.stdout.write(`${JSON.stringify(body.paused, null, 2)}\n`)
      } else if (body.paused.length === 0) {
        io.stdout.write('no paused runs\n')
      } else {
        for (const r of body.paused) {
          io.stdout.write(`${r.runId}\t${r.stepId}\t${r.kind}\t${new Date(r.at).toISOString()}\n`)
        }
      }
      return { exitCode: EXIT.OK }
    }
    case 'release': {
      if (!args.arg) {
        io.stderr.write('error: skelm debug release requires a run id\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
      const res = await fetchHttp(
        `${discovery.url}/debug/runs/${encodeURIComponent(args.arg)}/release`,
        { method: 'POST', headers },
      )
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return httpError(res, io)
      io.stdout.write(`released ${args.arg}\n`)
      return { exitCode: EXIT.OK }
    }
  }
}

async function fetchHttp(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, init)
  } catch (err) {
    process.stderr.write(`error: gateway HTTP request failed: ${(err as Error).message}\n`)
    return null
  }
}

async function httpError(res: Response, io: MainIO): Promise<MainResult> {
  io.stderr.write(`error: gateway returned ${res.status}: ${await res.text()}\n`)
  return { exitCode: EXIT.CLI_ERROR }
}
