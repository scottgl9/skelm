import { EXIT, type ExitCode } from './exit-codes.js'
import { fetchHttp, httpError, requireGateway } from './internal/gateway-client.js'
import type { MainIO } from './internal/io.js'

export interface ActivationResponse {
  project: { dir: string; configPath: string | null }
  trusted: boolean
  workflows: { id: string; kind: string }[]
  triggers: { id: string; kind: string; driver?: string; armed: boolean; lastError?: string }[]
  backends: { absorbed: string[]; skipped: string[] }
  grants: { absorbed: string[]; refused: string[] }
  agentmemory: string
  refresh: boolean
  message?: string
}

interface GatewayClient {
  discovery: { url: string }
  headers: Record<string, string>
}

/**
 * POST the directory to /v1/projects/activate. Returns the parsed response, or
 * null when the request failed (the error was already written to stderr).
 */
export async function requestActivation(
  client: GatewayClient,
  dir: string,
  io: MainIO,
): Promise<ActivationResponse | null> {
  const res = await fetchHttp(
    `${client.discovery.url}/v1/projects/activate`,
    {
      method: 'POST',
      headers: { ...client.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    },
    io,
  )
  if (res === null) return null
  if (!res.ok) {
    await httpError(res, io)
    return null
  }
  return (await res.json()) as ActivationResponse
}

/**
 * `skelm run <dir>` for a triggered/persistent project: hand the directory to
 * the gateway, which imports its config, registers its trigger sources +
 * workflow, arms the triggers, and takes ownership. The CLI prints a summary
 * and exits — the gateway owns the running workflow from here.
 */
export async function activateProject(dir: string, io: MainIO): Promise<{ exitCode: ExitCode }> {
  const client = await requireGateway(io)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }

  const body = await requestActivation(client, dir, io)
  if (body === null) return { exitCode: EXIT.CLI_ERROR }

  if (!body.trusted) {
    io.stderr.write(
      `error: ${body.message ?? 'project directory is outside the gateway trusted roots'}\n`,
    )
    return { exitCode: EXIT.CLI_ERROR }
  }

  io.stderr.write(`> ${body.refresh ? 'refreshed' : 'activated'} ${body.project.dir}\n`)
  for (const wf of body.workflows) {
    io.stderr.write(`>   workflow ${wf.id} (${wf.kind})\n`)
  }
  for (const t of body.triggers) {
    const via = t.driver !== undefined ? `${t.kind}/${t.driver}` : t.kind
    const state = t.armed ? 'armed' : `not armed${t.lastError ? `: ${t.lastError}` : ''}`
    io.stderr.write(`>   trigger ${t.id} (${via}) ${state}\n`)
  }
  if (body.backends.absorbed.length > 0) {
    io.stderr.write(`>   backends: ${body.backends.absorbed.join(', ')}\n`)
  }
  if (body.grants.absorbed.length > 0) {
    io.stderr.write(
      `>   ⚠ unrestricted bypass now LIVE for: ${body.grants.absorbed.join(', ')} — every bypassed turn is audited\n`,
    )
  }
  if (body.agentmemory === 'adopted') {
    io.stderr.write('>   agentmemory: adopted\n')
  }
  io.stderr.write(
    '> gateway now owns this workflow; run `skelm list` to see it, `skelm stop` to stop it\n',
  )
  return { exitCode: EXIT.OK }
}
