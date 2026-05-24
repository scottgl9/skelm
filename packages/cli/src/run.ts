import { accessSync, createReadStream, createWriteStream, constants as fsConstants } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  PermissionDeniedError,
  SchemaValidationError,
  StepTimeoutError,
  WaitTimeoutError,
} from '@skelm/core'
import type { Run } from '@skelm/core'
import { EXIT, type ExitCode } from './exit-codes.js'
import {
  type SseEvent,
  fetchHttp,
  httpError,
  openSse,
  requireGateway,
} from './internal/gateway-client.js'
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
    // Sync execution: gateway runs the workflow to completion and returns
    // the final state. We then fetch /runs/:id/events to render the event
    // log in the user's chosen --events mode. Live streaming via SSE is a
    // follow-up; per-request Runners don't currently fan events back through
    // the gateway-wide event bus that GET /runs/:id/stream subscribes to.
    const runRes = await fetchHttp(
      `${client.discovery.url}/pipelines/run-file`,
      {
        method: 'POST',
        headers: client.headers,
        body: JSON.stringify({ file: absPath, input: input ?? {} }),
      },
      io as MainIO,
      // Match the gateway's 5-minute sync-run cap so we don't time out earlier.
      5 * 60_000,
    )
    if (runRes === null) return { exitCode: EXIT.CLI_ERROR }
    if (!runRes.ok) {
      return (await httpError(runRes, io as MainIO)) as { exitCode: ExitCode }
    }
    const result = (await runRes.json()) as {
      runId: string
      pipelineId?: string
      status: 'completed' | 'failed' | 'cancelled' | 'paused'
      output?: unknown
      error?: { name?: string; message?: string }
    }
    activeRunId = result.runId

    if (eventMode === 'human') {
      io.stderr.write(`> running ${result.pipelineId ?? absPath} (runId=${result.runId})\n`)
    }

    // Pull and render the event log produced during this run.
    if (eventMode !== 'none') {
      const evRes = await fetchHttp(
        `${client.discovery.url}/runs/${result.runId}/events?limit=5000`,
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

    // Fetch full run state for typed exit-code mapping.
    const stateRes = await fetchHttp(
      `${client.discovery.url}/runs/${result.runId}`,
      { headers: client.headers },
      io as MainIO,
    )
    const run = stateRes?.ok
      ? ((await stateRes.json()) as Run<unknown, unknown>)
      : ({
          runId: result.runId,
          status: result.status,
          output: result.output,
          ...(result.error !== undefined && { error: result.error }),
        } as unknown as Run<unknown, unknown>)

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
 * If the SSE event is a `run.waiting`, prompt the user for resume JSON
 * and POST it to /runs/:runId/resume. Returns true if the event was a
 * wait and was handled (so the caller skips default rendering).
 *
 * Schema-side validation is now gateway-side: we pass through whatever
 * the user typed and let the gateway's wait step surface a validation
 * failure as a step error if needed. This is a deliberate v1 simplification
 * — pre-refactor the CLI did schema validation client-side, which only
 * worked because the workflow ran in-process.
 */
async function maybeHandleWait(
  ev: SseEvent,
  runId: string,
  client: { discovery: { url: string }; headers: Record<string, string> },
  io: RunCommandIO,
): Promise<boolean> {
  if (
    ev.event !== 'run.waiting' &&
    !(
      typeof ev.data === 'object' &&
      ev.data !== null &&
      (ev.data as { type?: string }).type === 'run.waiting'
    )
  ) {
    return false
  }
  const payload = (typeof ev.data === 'object' && ev.data !== null ? ev.data : {}) as {
    stepId?: string
    message?: string
    timeoutMs?: number
  }
  const req: SimpleWaitRequest = { stepId: payload.stepId ?? '(wait)' }
  if (payload.message !== undefined) req.message = payload.message
  if (payload.timeoutMs !== undefined) req.timeoutMs = payload.timeoutMs
  const value = await promptForWaitInput(req, io)
  const res = await fetchHttp(
    `${client.discovery.url}/runs/${runId}/resume`,
    {
      method: 'POST',
      headers: { ...client.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ output: value }),
    },
    io as MainIO,
  )
  if (res !== null && !res.ok) {
    await httpError(res, io as MainIO)
  }
  return true
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

interface SimpleWaitRequest {
  stepId: string
  message?: string
  timeoutMs?: number
}

async function promptForWaitInput(request: SimpleWaitRequest, io: RunCommandIO): Promise<unknown> {
  const promptIo = openPromptIo(io)
  const controller = new AbortController()
  let timedOut = false
  const timer =
    request.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          controller.abort()
        }, request.timeoutMs)
  timer?.unref?.()
  const rl = createInterface({
    input: promptIo.input,
    output: promptIo.output,
    terminal: isTtyStream(promptIo.input) && isTtyStream(promptIo.output),
  })
  try {
    promptIo.output.write(
      `> waiting at ${request.stepId}${request.message ? `: ${request.message}` : ''}${
        request.timeoutMs !== undefined ? ` (timeout ${request.timeoutMs}ms)` : ''
      }\n`,
    )
    promptIo.output.write('> enter resume JSON\n')
    while (true) {
      let raw: string
      try {
        raw = await rl.question('resume JSON> ', { signal: controller.signal })
      } catch {
        if (timedOut) {
          throw new CliError(`wait(${request.stepId}) timed out`, 'wait-timeout')
        }
        throw new CliError(`wait(${request.stepId}) input cancelled`, 'wait-cancelled')
      }
      const trimmed = raw.trim()
      if (trimmed.length === 0) {
        promptIo.output.write('! enter JSON (use null for an empty value)\n')
        continue
      }
      try {
        return JSON.parse(trimmed)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        promptIo.output.write(`! invalid JSON: ${detail}\n`)
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    rl.close()
    promptIo.close()
  }
}

function openPromptIo(io: RunCommandIO): {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  close: () => void
} {
  if (
    process.platform !== 'win32' &&
    io.stdin === process.stdin &&
    io.stderr === process.stderr &&
    process.stderr.isTTY
  ) {
    try {
      accessSync('/dev/tty', fsConstants.R_OK | fsConstants.W_OK)
      const input = createReadStream('/dev/tty')
      const output = createWriteStream('/dev/tty')
      return {
        input,
        output,
        close: () => {
          input.destroy()
          output.end()
        },
      }
    } catch {
      // Fall back to the injected IO streams when /dev/tty is unavailable.
    }
  }
  return {
    input: io.stdin,
    output: io.stderr,
    close: () => {},
  }
}

function isTtyStream(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
  return 'isTTY' in stream && stream.isTTY === true
}
