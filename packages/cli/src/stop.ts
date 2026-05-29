import { EXIT, type ExitCode } from './exit-codes.js'
import { fetchHttp, httpError, requireGateway } from './internal/gateway-client.js'
import type { MainIO } from './internal/io.js'

export interface StopCommandArgs {
  id?: string
  cancelInflight?: boolean
  json?: boolean
}

interface DeactivationResponse {
  deactivated: boolean
  id: string
  triggersRemoved: string[]
  runsCancelled: string[]
}

/**
 * `skelm stop <id>` — deactivate a workflow on the gateway: unregister its
 * triggers (stopping its queue driver) and drop its registration. Persisted
 * sessions survive so a re-activation resumes the conversation. Pass
 * `--cancel-inflight` to also cancel its running turns. Distinct from
 * `skelm gateway stop` (stops the whole process).
 */
export async function stopCommand(
  args: StopCommandArgs,
  io: MainIO,
): Promise<{ exitCode: ExitCode }> {
  if (args.id === undefined || args.id.length === 0) {
    io.stderr.write('error: skelm stop requires a workflow id\n')
    return { exitCode: EXIT.CLI_ERROR }
  }

  const client = await requireGateway(io)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }

  const res = await fetchHttp(
    `${client.discovery.url}/v1/workflows/${encodeURIComponent(args.id)}/deactivate`,
    {
      method: 'POST',
      headers: { ...client.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ cancelInflight: args.cancelInflight === true }),
    },
    io,
  )
  if (res === null) return { exitCode: EXIT.CLI_ERROR }
  if (!res.ok) return (await httpError(res, io)) as { exitCode: ExitCode }

  const body = (await res.json()) as DeactivationResponse
  if (args.json === true) {
    io.stdout.write(`${JSON.stringify(body)}\n`)
    return { exitCode: EXIT.OK }
  }
  const cancelled =
    body.runsCancelled.length > 0 ? `, ${body.runsCancelled.length} run(s) cancelled` : ''
  io.stdout.write(`stopped ${body.id} (${body.triggersRemoved.length} trigger(s)${cancelled})\n`)
  return { exitCode: EXIT.OK }
}
