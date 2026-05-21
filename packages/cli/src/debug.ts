import { EXIT } from './exit-codes.js'
import { ensureGatewayReady, fetchHttp, httpError } from './internal/gateway-client.js'
import type { MainIO, MainResult } from './internal/io.js'
import { writeJsonOutput } from './internal/output.js'

export interface DebugArgs {
  subcommand: 'breakpoints' | 'add' | 'remove' | 'runs' | 'release'
  /** For add / remove: the step id. For release: the run id. */
  arg?: string
  json?: boolean
}

export async function debugCommand(args: DebugArgs, io: MainIO): Promise<MainResult> {
  const client = await ensureGatewayReady(io)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }
  const { discovery, headers } = client

  switch (args.subcommand) {
    case 'breakpoints': {
      const res = await fetchHttp(`${discovery.url}/debug/breakpoints`, { headers }, io)
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return httpError(res, io)
      const body = (await res.json()) as { breakpoints: string[] }
      if (args.json) {
        writeJsonOutput(io, body.breakpoints)
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
      const res = await fetchHttp(
        `${discovery.url}/debug/breakpoints`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ stepId: args.arg }),
        },
        io,
      )
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
        io,
      )
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return httpError(res, io)
      io.stdout.write(`removed ${args.arg}\n`)
      return { exitCode: EXIT.OK }
    }
    case 'runs': {
      const res = await fetchHttp(`${discovery.url}/debug/runs`, { headers }, io)
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return httpError(res, io)
      const body = (await res.json()) as {
        paused: Array<{ runId: string; stepId: string; kind: string; at: number }>
      }
      if (args.json) {
        writeJsonOutput(io, body.paused)
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
        io,
      )
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return httpError(res, io)
      io.stdout.write(`released ${args.arg}\n`)
      return { exitCode: EXIT.OK }
    }
  }
}
