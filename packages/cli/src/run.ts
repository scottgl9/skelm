import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  PermissionDeniedError,
  SchemaValidationError,
  StepTimeoutError,
  WaitTimeoutError,
} from '@skelm/core'
import type { Run } from '@skelm/core'
import { EXIT, type ExitCode } from './exit-codes.js'
import { type SseEvent, fetchHttp, httpError, requireGateway } from './internal/gateway-client.js'
import type { MainIO } from './internal/io.js'
import { safeForTty } from './internal/safe-text.js'
import { CliError } from './load-workflow.js'

export interface RunCommandArgs {
  workflowPath: string
  input?: string
  inputFile?: string
  inputStdin?: boolean
  output?: string
  events?: 'human' | 'json' | 'none'
}

export interface RunCommandIO {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  stdin: NodeJS.ReadableStream
}

export interface RunCommandResult {
  exitCode: ExitCode
  run?: Run<unknown, unknown>
}

/**
 * Implementation of `skelm run <workflow>`.
 *
 * As of the CLI-as-gateway-interface refactor this command no longer
 * executes pipelines in-process. It:
 *   1. Resolves the input (--input / --input-file / --input-stdin)
 *   2. Requires a running gateway (auto-starts one when none is up)
 *   3. POSTs the absolute workflow path to /pipelines/start-file
 *   4. Subscribes to /runs/:runId/stream over SSE and renders events
 *      to stderr per the --events mode
 *   5. Drives the resume prompt when the gateway emits a run.waiting event
 *   6. Fetches the final run state, writes the output JSON to stdout,
 *      and exits with the appropriate code
 *
 * Permission enforcement, secret resolution, audit, MCP host setup, the
 * run store, and the workspace manager all live gateway-side; the CLI
 * no longer constructs any of them.
 */
export async function runCommand(
  args: RunCommandArgs,
  io: RunCommandIO,
): Promise<RunCommandResult> {
  const { workflowPath } = args
  if (!workflowPath) {
    io.stderr.write('error: missing workflow path\n')
    return { exitCode: EXIT.CLI_ERROR }
  }

  let input: unknown
  try {
    input = await resolveInput(args, io.stdin)
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr.write(`error: ${err.message}\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    throw err
  }

  const eventMode: 'human' | 'json' | 'none' = args.events ?? 'human'
  const absPath = resolve(process.cwd(), workflowPath)

  const client = await requireGateway(io as MainIO)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }

  // SIGINT cancels the remote run if we know its id.
  let activeRunId: string | undefined
  const onSig = () => {
    if (activeRunId === undefined) return
    void fetchHttp(
      `${client.discovery.url}/runs/${activeRunId}`,
      { method: 'DELETE', headers: client.headers },
      io as MainIO,
      5_000,
    )
  }
  process.once('SIGINT', onSig)
  process.once('SIGTERM', onSig)

  try {
    // Async execution + polling: POST /pipelines/start-file fires the run
    // and returns the runId immediately. We then poll GET /runs/:id until
    // a terminal-or-waiting state is reached, so a workflow that parks on
    // wait() doesn't hang the CLI forever (the sync /pipelines/run-file
    // path awaits handle.wait() which never resolves for a paused run).
    //
    // Live SSE event streaming via GET /runs/:id/stream is supported on
    // the gateway side (see the gateway.events shared bus), but h3's
    // createEventStream doesn't flush headers eagerly enough for undici
    // fetch to begin yielding chunks from a sub-second run. Polling is
    // correct and simple here — the gateway is local so per-poll latency
    // is sub-millisecond.
    const startRes = await fetchHttp(
      `${client.discovery.url}/pipelines/start-file`,
      {
        method: 'POST',
        headers: client.headers,
        body: JSON.stringify({ file: absPath, input: input ?? {} }),
      },
      io as MainIO,
    )
    if (startRes === null) return { exitCode: EXIT.CLI_ERROR }
    if (!startRes.ok) {
      return (await httpError(startRes, io as MainIO)) as { exitCode: ExitCode }
    }
    const started = (await startRes.json()) as { runId: string; pipelineId?: string }
    activeRunId = started.runId

    if (eventMode === 'human') {
      io.stderr.write(`> running ${started.pipelineId ?? absPath} (runId=${started.runId})\n`)
    }

    // Poll until terminal-or-paused. 150ms cadence is fast enough for
    // sub-second runs to feel synchronous, slow enough not to overwhelm
    // an in-process gateway. 5-minute hard cap matches the prior sync
    // endpoint's behaviour.
    //
    // The runner keeps `Run.status` at 'running' while a wait() step is
    // parked (it only flips to a terminal status on finalize), so we
    // also scan the recent event log for an unmatched `run.waiting` to
    // detect the paused condition.
    //
    // TODO(refactor/cli-gateway-dispatch follow-up): expose
    // `Run.waiting?: WaitRequest` on the gateway's run state so the CLI
    // can detect pause from a single GET /runs/:id instead of a second
    // GET /runs/:id/events. Also re-enable interactive resume from the
    // CLI once live SSE consumption lands (h3 createEventStream header
    // flush is the current blocker — see comments above).
    const deadline = Date.now() + 5 * 60_000
    let run: Run<unknown, unknown> | null = null
    let pausedAtWait = false
    // Grace window so a wait() step with its own short timeoutMs gets a
    // chance to time out naturally (-> WAIT_TIMEOUT) before we declare
    // it stuck (-> RUN_PAUSED). The shortest fixture uses 50ms, so we
    // wait at least one full second of "still parked at wait" before
    // breaking out.
    let waitingSinceMs: number | null = null
    const PAUSE_GRACE_MS = 1_000
    while (Date.now() < deadline) {
      const stateRes = await fetchHttp(
        `${client.discovery.url}/runs/${started.runId}`,
        { headers: client.headers },
        io as MainIO,
      )
      if (stateRes === null) return { exitCode: EXIT.CLI_ERROR }
      if (!stateRes.ok) {
        return (await httpError(stateRes, io as MainIO)) as { exitCode: ExitCode }
      }
      run = (await stateRes.json()) as Run<unknown, unknown>
      const s = run.status
      if (s === 'completed' || s === 'failed' || s === 'cancelled') break
      if (await isPausedAtWait(client, started.runId, io as MainIO)) {
        if (waitingSinceMs === null) waitingSinceMs = Date.now()
        if (Date.now() - waitingSinceMs >= PAUSE_GRACE_MS) {
          pausedAtWait = true
          break
        }
      } else {
        waitingSinceMs = null
      }
      await new Promise((r) => setTimeout(r, 150))
    }
    if (run === null) {
      io.stderr.write(
        `error: run ${started.runId} timed out after 5 minutes without terminal state\n`,
      )
      return { exitCode: EXIT.CLI_ERROR }
    }

    if (eventMode !== 'none') {
      const evRes = await fetchHttp(
        `${client.discovery.url}/runs/${started.runId}/events?limit=5000`,
        { headers: client.headers },
        io as MainIO,
      )
      if (evRes?.ok) {
        const { events } = (await evRes.json()) as { events: unknown[] }
        for (const e of events) {
          renderEvent({ event: 'message', id: undefined, data: e, raw: '' }, eventMode, io)
        }
      }
    }

    if (run.status === 'completed') {
      io.stdout.write(`${JSON.stringify(run.output)}\n`)
      if (eventMode === 'human') {
        io.stderr.write(`> completed (runId=${run.runId})\n`)
      }
      return { exitCode: EXIT.OK, run }
    }
    if (run.status === 'cancelled') {
      if (eventMode === 'human') {
        io.stderr.write(`> cancelled (runId=${run.runId})\n`)
      }
      return { exitCode: EXIT.CANCELLED, run }
    }
    if (pausedAtWait) {
      // wait() step is awaiting external input. Interactive resume from
      // the CLI isn't wired yet (needs live SSE delivery — see
      // packages/cli/src/run.ts:96-105). Surface this clearly instead of
      // falling through to a misleading "> failed: unknown" line, and
      // exit with the documented RUN_PAUSED code so scripts can branch.
      io.stderr.write(
        [
          `> paused (runId=${run.runId}): workflow is awaiting input at a wait() step.`,
          '  Interactive resume from the CLI is not yet available.',
          '  Resume directly on the gateway:',
          `    curl -X POST ${client.discovery.url}/runs/${run.runId}/resume \\`,
          "      -H 'content-type: application/json' \\",
          `      -d '{"output": <your-json-here>}'`,
          '',
        ].join('\n'),
      )
      return { exitCode: EXIT.RUN_PAUSED, run }
    }
    if (eventMode === 'human') {
      const prefix = run.error?.name ? `${safeForTty(run.error.name)}: ` : ''
      io.stderr.write(
        `> failed (runId=${run.runId}): ${prefix}${safeForTty(run.error?.message ?? 'unknown')}\n`,
      )
    }
    return { exitCode: mapRunErrorToExit(run.error?.name), run }
  } finally {
    process.off('SIGINT', onSig)
    process.off('SIGTERM', onSig)
  }
}

/**
 * Read the recent events for a run and return true if the run is parked
 * at a wait() step — i.e. the most recent `run.waiting` event is not
 * yet followed by a `run.resumed` or a terminal event. Used during the
 * poll loop because the runner keeps `Run.status === 'running'` while
 * waiting.
 */
async function isPausedAtWait(
  client: { discovery: { url: string }; headers: Record<string, string> },
  runId: string,
  io: MainIO,
): Promise<boolean> {
  const res = await fetchHttp(
    `${client.discovery.url}/runs/${encodeURIComponent(runId)}/events?limit=200`,
    { headers: client.headers },
    io,
  )
  if (res === null || !res.ok) return false
  const { events } = (await res.json()) as { events: Array<{ type?: string }> }
  let waiting = false
  for (const e of events) {
    if (e.type === 'run.waiting') waiting = true
    else if (
      e.type === 'run.resumed' ||
      e.type === 'run.completed' ||
      e.type === 'run.failed' ||
      e.type === 'run.cancelled'
    )
      waiting = false
  }
  return waiting
}

/**
 * Render a single SSE event to stderr. Mirrors the human/json formats
 * the pre-refactor in-process bus produced so existing tests and operator
 * muscle memory survive the dispatch flip.
 */
function renderEvent(ev: SseEvent, mode: 'human' | 'json' | 'none', io: RunCommandIO): void {
  if (mode === 'none') return
  const data = ev.data as Record<string, unknown> | undefined
  if (mode === 'json') {
    if (data !== undefined && typeof data === 'object') {
      io.stderr.write(`${JSON.stringify(data)}\n`)
    } else if (ev.raw !== '') {
      io.stderr.write(`${ev.raw}\n`)
    }
    return
  }
  // human mode
  if (data === undefined || typeof data !== 'object') return
  const type = (data as { type?: string }).type
  switch (type) {
    case 'run.started':
      // Already printed in runCommand body once we know the runId.
      break
    case 'step.start':
      io.stderr.write(`  - ${safeForTty(String(data.stepId))} (${String(data.kind)})\n`)
      break
    case 'step.error': {
      const err = data.error as { name?: string; message?: string } | undefined
      const name = err?.name && err.name !== 'Error' ? `${safeForTty(err.name)}: ` : ''
      io.stderr.write(
        `  ! ${safeForTty(String(data.stepId))}: ${name}${safeForTty(err?.message ?? 'unknown')}\n`,
      )
      break
    }
    default:
      break
  }
}

function mapRunErrorToExit(errorName: string | undefined): ExitCode {
  switch (errorName) {
    case SchemaValidationError.name:
      return EXIT.SCHEMA_VALIDATION
    case WaitTimeoutError.name:
      return EXIT.WAIT_TIMEOUT
    case PermissionDeniedError.name:
      return EXIT.PERMISSION_DENIED
    case StepTimeoutError.name:
      return EXIT.STEP_TIMEOUT
    default:
      return EXIT.RUN_FAILED
  }
}

async function resolveInput(args: RunCommandArgs, stdin: NodeJS.ReadableStream): Promise<unknown> {
  const provided = [args.input, args.inputFile, args.inputStdin ? 'stdin' : undefined].filter(
    (x) => x !== undefined,
  )
  if (provided.length > 1) {
    throw new CliError('pass at most one of --input, --input-file, --input-stdin', 'argv')
  }

  if (args.input !== undefined) {
    return parseJson(args.input, '--input')
  }
  if (args.inputFile !== undefined) {
    const raw = await readFile(args.inputFile, 'utf8')
    return parseJson(raw, args.inputFile)
  }
  if (args.inputStdin) {
    const raw = await readStream(stdin)
    return parseJson(raw, 'stdin')
  }
  return undefined
}

function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new CliError(`invalid JSON from ${source}: ${detail}`, 'bad-input')
  }
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}
