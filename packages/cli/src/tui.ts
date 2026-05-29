import { createInterface } from 'node:readline'
import { requestActivation } from './activate.js'
import { EXIT, type ExitCode } from './exit-codes.js'
import { fetchHttp, openSse, requireGateway } from './internal/gateway-client.js'
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
 * `/v1/tui/:sourceId/submit`, which returns the turn's runId; the CLI tails
 * `/runs/:runId/stream` for partials and the final reply. On EOF / Ctrl-C the
 * workflow is deactivated (its durable conversation is kept) and the CLI exits.
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
      const reply = await runTurn(sourceId, sessionId, text, client, io)
      if (reply !== null) io.stdout.write(`${reply}\n`)
    }
  } finally {
    rl.close()
  }
}

/**
 * Submit one line and follow the turn's run stream. Calls `onPartial` with the
 * cumulative reply as `step.partial` deltas arrive, and resolves with the final
 * reply text (or null on failure).
 */
export async function runTurn(
  sourceId: string,
  sessionId: string,
  text: string,
  client: GatewayClient,
  io: MainIO,
  onPartial?: (cumulative: string) => void,
): Promise<string | null> {
  const submitRes = await fetchHttp(
    `${client.discovery.url}/v1/tui/${encodeURIComponent(sourceId)}/submit`,
    {
      method: 'POST',
      headers: { ...client.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
    },
    io,
  )
  if (submitRes === null || !submitRes.ok) {
    io.stderr.write('> turn failed\n')
    return null
  }
  const { runId } = (await submitRes.json()) as { runId: string }

  let acc = ''
  let reply: string | null = null
  try {
    for await (const ev of openSse(
      `${client.discovery.url}/runs/${runId}/stream`,
      client.headers,
    )) {
      if (ev.event === 'ping') continue
      const data = ev.data as { type?: string; delta?: string; output?: { reply?: unknown } }
      const type = ev.event !== 'message' ? ev.event : (data?.type ?? 'message')
      if (type === 'step.partial' && typeof data?.delta === 'string') {
        acc += data.delta
        onPartial?.(acc)
      } else if (type === 'run.completed') {
        const out = data?.output?.reply
        reply = typeof out === 'string' ? out : acc
        break
      } else if (type === 'run.failed' || type === 'run.cancelled') {
        break
      }
    }
  } catch {
    // Stream interrupted — fall back to the final run state below.
  }

  if (reply === null) {
    const stateRes = await fetchHttp(
      `${client.discovery.url}/runs/${runId}`,
      { headers: client.headers },
      io,
    )
    if (stateRes?.ok) {
      const run = (await stateRes.json()) as { output?: { reply?: unknown } }
      if (typeof run.output?.reply === 'string') reply = run.output.reply
    }
  }
  return reply ?? acc
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
