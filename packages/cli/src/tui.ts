import { createInterface } from 'node:readline'
import { type ActivationResponse, requestActivation } from './activate.js'
import { EXIT, type ExitCode } from './exit-codes.js'
import { fetchHttp, requireGateway } from './internal/gateway-client.js'
import type { MainIO } from './internal/io.js'

export interface TuiCommandArgs {
  dir: string
  sourceId: string
  sessionId?: string
}

interface GatewayClient {
  discovery: { url: string }
  headers: Record<string, string>
}

/**
 * `skelm run <tui-dir>`: activate the project on the gateway, then host the
 * terminal chat in THIS process. Each line is POSTed to
 * `/v1/tui/:sourceId/submit`; the workflow runs a turn gateway-side and its
 * reply is printed here. On EOF / Ctrl-C the workflow is deactivated (its
 * durable conversation is kept) and the CLI exits.
 */
export async function tuiCommand(
  args: TuiCommandArgs,
  io: MainIO,
): Promise<{ exitCode: ExitCode }> {
  const client = await requireGateway(io)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }

  const activation = await requestActivation(client, args.dir, io)
  if (activation === null) return { exitCode: EXIT.CLI_ERROR }
  if (!activation.trusted) {
    io.stderr.write(
      `error: ${activation.message ?? 'project is outside the gateway trusted roots'}\n`,
    )
    return { exitCode: EXIT.CLI_ERROR }
  }

  const workflowId = activation.workflows[0]?.id
  const sessionId = args.sessionId ?? process.env.TUI_SESSION_ID ?? 'tui'

  io.stderr.write(
    `> ${activation.project.dir} — chat session "${sessionId}" (Ctrl-C / Ctrl-D to exit)\n`,
  )
  try {
    await chatLoop(args.sourceId, sessionId, client, io)
  } finally {
    if (workflowId !== undefined) await deactivate(workflowId, client, io)
  }
  return { exitCode: EXIT.OK }
}

async function chatLoop(
  sourceId: string,
  sessionId: string,
  client: GatewayClient,
  io: MainIO,
): Promise<void> {
  const rl = createInterface({ input: io.stdin })
  try {
    for await (const line of rl) {
      const text = line.trim()
      if (text.length === 0) continue
      const reply = await submit(sourceId, sessionId, text, client, io)
      if (reply !== null) io.stdout.write(`${reply}\n`)
    }
  } finally {
    rl.close()
  }
}

async function submit(
  sourceId: string,
  sessionId: string,
  text: string,
  client: GatewayClient,
  io: MainIO,
): Promise<string | null> {
  const res = await fetchHttp(
    `${client.discovery.url}/v1/tui/${encodeURIComponent(sourceId)}/submit`,
    {
      method: 'POST',
      headers: { ...client.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
    },
    io,
  )
  if (res === null || !res.ok) {
    io.stderr.write('> turn failed\n')
    return null
  }
  const body = (await res.json()) as { reply?: unknown }
  return typeof body.reply === 'string' ? body.reply : ''
}

async function deactivate(workflowId: string, client: GatewayClient, io: MainIO): Promise<void> {
  await fetchHttp(
    `${client.discovery.url}/v1/workflows/${encodeURIComponent(workflowId)}/deactivate`,
    {
      method: 'POST',
      headers: { ...client.headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
    io,
  )
  io.stderr.write(`> stopped ${workflowId} (session kept)\n`)
}
