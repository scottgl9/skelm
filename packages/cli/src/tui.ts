import { createInterface } from 'node:readline'
import { requestActivation } from './activate.js'
import type { TuiFrontendFactoryLike, TuiFrontendLike } from './classify-run-target.js'
import { EXIT, type ExitCode } from './exit-codes.js'
import { fetchHttp, openSse, requireGateway } from './internal/gateway-client.js'
import type { MainIO } from './internal/io.js'

export interface TuiCommandArgs {
  dir: string
  sourceId: string
  sessionId?: string
  /** Project-supplied terminal UI; when absent, a plain readline host is used. */
  frontend?: TuiFrontendFactoryLike
}

/** A single turn: submit `text`, stream partials to `onPartial`, resolve the reply. */
export type TurnFn = (text: string, onPartial: (cumulative: string) => void) => Promise<string>

interface GatewayClient {
  discovery: { url: string }
  headers: Record<string, string>
}

/**
 * `skelm run <tui-dir>`: activate the project on the gateway, then host the
 * terminal chat in THIS process. Each line is POSTed to
 * `/v1/chat/:sourceId/submit`, which returns the turn's runId; the CLI tails
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
  const turn: TurnFn = (text, onPartial) =>
    runTurn(args.sourceId, sessionId, text, client, io, onPartial)
  try {
    if (args.frontend !== undefined) {
      await hostFrontend(args.frontend, sessionId, turn)
    } else {
      await chatLoop(turn, io)
    }
  } finally {
    if (workflowId !== undefined) await deactivate(workflowId, client, io)
  }
  return { exitCode: EXIT.OK }
}

/**
 * Host a project-supplied terminal UI (e.g. Ink). The frontend owns input and
 * calls `io.submit(text)` per line; the host runs each turn serially, streaming
 * partials to `frontend.renderPartial` and committing the reply with
 * `frontend.render`. Resolves when the user exits (SIGINT) and the UI tears down.
 */
async function hostFrontend(
  factory: TuiFrontendFactoryLike,
  sessionId: string,
  turn: TurnFn,
): Promise<void> {
  const host = createFrontendHost(factory, sessionId, turn)
  await new Promise<void>((resolve) => {
    const onSig = (): void => resolve()
    process.once('SIGINT', onSig)
  })
  await host.idle()
  await host.ui.close?.()
}

/**
 * Wire a frontend factory to a turn runner. Exposed for testing without a TTY:
 * pass a fake factory whose `io.submit` is called programmatically and assert on
 * the recorded `render` / `renderPartial` calls. Turns run one at a time;
 * lines submitted while a turn is in flight queue behind it.
 */
export function createFrontendHost(
  factory: TuiFrontendFactoryLike,
  sessionId: string,
  turn: TurnFn,
): { ui: TuiFrontendLike; idle: () => Promise<void> } {
  let seq = 0
  let active = 0
  const queue: string[] = []
  const idleWaiters: Array<() => void> = []

  const settleIdle = (): void => {
    if (active === 0 && queue.length === 0) {
      for (const w of idleWaiters.splice(0)) w()
    }
  }

  const process = async (text: string): Promise<void> => {
    active += 1
    seq += 1
    const payload = { sessionId, from: 'you', text, seq }
    try {
      const reply = await turn(text, (cumulative) => ui.renderPartial?.(cumulative))
      ui.render(reply, payload)
    } finally {
      active -= 1
      const next = queue.shift()
      if (next !== undefined) void process(next)
      else settleIdle()
    }
  }

  const ui: TuiFrontendLike = factory({
    submit: (text: string): void => {
      const trimmed = text.trim()
      if (trimmed === '') return
      if (active > 0) queue.push(trimmed)
      else void process(trimmed)
    },
  })

  return {
    ui,
    idle: () =>
      active === 0 && queue.length === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => idleWaiters.push(resolve)),
  }
}

async function chatLoop(turn: TurnFn, io: MainIO): Promise<void> {
  const rl = createInterface({ input: io.stdin })
  try {
    for await (const line of rl) {
      const text = line.trim()
      if (text.length === 0) continue
      const reply = await turn(text, () => {})
      if (reply !== '') io.stdout.write(`${reply}\n`)
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
): Promise<string> {
  const submitRes = await fetchHttp(
    `${client.discovery.url}/v1/chat/${encodeURIComponent(sourceId)}/submit`,
    {
      method: 'POST',
      headers: { ...client.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
    },
    io,
  )
  if (submitRes === null || !submitRes.ok) {
    const detail =
      submitRes === null
        ? 'gateway unreachable'
        : `gateway returned ${submitRes.status} ${submitRes.statusText}`
    io.stderr.write(`> turn failed: ${detail}\n`)
    return `(submit failed) ${detail}`
  }
  const { runId } = (await submitRes.json()) as { runId: string }

  let acc = ''
  let reply: string | null = null
  let failure: { kind: 'failed' | 'cancelled'; message?: string } | undefined
  try {
    for await (const ev of openSse(
      `${client.discovery.url}/runs/${runId}/stream`,
      client.headers,
    )) {
      if (ev.event === 'ping') continue
      const data = ev.data as {
        type?: string
        delta?: string
        output?: { reply?: unknown }
        error?: { message?: unknown }
      }
      const type = ev.event !== 'message' ? ev.event : (data?.type ?? 'message')
      if (type === 'step.partial' && typeof data?.delta === 'string') {
        acc += data.delta
        onPartial?.(acc)
      } else if (type === 'run.completed') {
        const out = data?.output?.reply
        reply = typeof out === 'string' ? out : acc
        break
      } else if (type === 'run.failed' || type === 'run.cancelled') {
        const msg = typeof data?.error?.message === 'string' ? data.error.message : undefined
        failure = {
          kind: type === 'run.failed' ? 'failed' : 'cancelled',
          ...(msg && { message: msg }),
        }
        break
      }
    }
  } catch {
    // Stream interrupted — fall back to the final run state below.
  }

  // Failure paths: refetch the run record to pick up an error message the
  // SSE stream may have missed (e.g. when the failure landed before the
  // subscriber attached) and turn the failure into a visible reply so a
  // silent "thinking…" forever is impossible.
  if (reply === null) {
    const stateRes = await fetchHttp(
      `${client.discovery.url}/runs/${runId}`,
      { headers: client.headers },
      io,
    )
    if (stateRes?.ok) {
      const run = (await stateRes.json()) as {
        status?: string
        output?: { reply?: unknown }
        error?: { message?: unknown }
      }
      if (typeof run.output?.reply === 'string' && run.output.reply !== '') {
        reply = run.output.reply
      } else if (run.status === 'failed' || run.status === 'cancelled') {
        const msg = typeof run.error?.message === 'string' ? run.error.message : undefined
        failure = {
          kind: run.status === 'failed' ? 'failed' : 'cancelled',
          ...(msg && { message: msg }),
        }
      }
    }
  }

  if (reply === null && failure !== undefined) {
    return `(${failure.kind}) ${failure.message ?? 'no error message'}`
  }
  return reply ?? (acc === '' ? '(no reply)' : acc)
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
