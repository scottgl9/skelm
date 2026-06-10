import { accessSync, createReadStream, createWriteStream, constants as fsConstants } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  BackendCapabilityError,
  PermissionDeniedError,
  SchemaValidationError,
  StepTimeoutError,
  WaitTimeoutError,
} from '@skelm/core'
import type { Run } from '@skelm/core'
import { activateProject } from './activate.js'
import { classifyRunTarget } from './classify-run-target.js'
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
import { findSkelmConfigPath } from './load-config.js'
import { CliError } from './load-workflow.js'
import { tuiCommand } from './tui.js'

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
 * As of the CLI-as-gateway-interface refactor this command does not
 * execute pipelines in-process. It:
 *   1. Resolves the input (--input / --input-file / --input-stdin)
 *   2. Requires a running gateway (auto-starts one when none is up)
 *   3. POSTs the absolute workflow path to /pipelines/start-file
 *   4. Subscribes to /runs/:runId/stream over SSE and renders events
 *      to stderr per the --events mode
 *   5. Drives the resume prompt when the gateway emits a run.waiting event
 *   6. On a terminal event, fetches the final Run state, writes the
 *      output JSON to stdout, and exits with the appropriate code
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
  let absPath: string
  try {
    // A triggered/persistent project directory is activated on the gateway and
    // owned there; the CLI prints a summary and exits. A file (or a plain
    // pipeline directory) is a one-shot run the CLI streams and waits on.
    const target = await classifyRunTarget(workflowPath)
    if (target.mode === 'activate') {
      return activateProject(target.dir, io as MainIO)
    }
    if (target.mode === 'tui') {
      return tuiCommand(
        {
          dir: target.dir,
          sourceId: target.sourceId,
          ...(target.frontend !== undefined && { frontend: target.frontend }),
        },
        io as MainIO,
      )
    }
    input = await resolveInput(args, io.stdin)
    absPath = target.file
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr.write(`error: ${err.message}\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    throw err
  }

  const eventMode: 'human' | 'json' | 'none' = args.events ?? 'human'

  const client = await requireGateway(io as MainIO)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }

  // SIGINT cancels the remote run if we know its id.
  let activeRunId: string | undefined
  let cancelPromise: Promise<unknown> | undefined
  const sseAbort = new AbortController()
  const onSig = () => {
    const runId = activeRunId
    if (runId !== undefined && cancelPromise === undefined) {
      cancelPromise = fetchHttp(
        `${client.discovery.url}/runs/${runId}`,
        { method: 'DELETE', headers: client.headers },
        io as MainIO,
        5_000,
      ).catch(() => undefined)
    }
    sseAbort.abort()
  }
  process.once('SIGINT', onSig)
  process.once('SIGTERM', onSig)

  const waitForCancelRequest = async (): Promise<void> => {
    if (cancelPromise !== undefined) await cancelPromise
  }

  try {
    // /pipelines/start-file fires the run and returns the runId
    // immediately. We then subscribe to /runs/:runId/stream over SSE.
    // The gateway's stream handler is replay-then-tail: even if the run
    // completes between start and subscribe (sub-second runs), the
    // client receives every persisted event in order.
    //
    // Include the nearest skelm.config.* from the workflow file's directory
    // so the gateway can apply its defaults.permissions and backends for this run.
    const configPath = findSkelmConfigPath(dirname(absPath))
    const startRes = await fetchHttp(
      `${client.discovery.url}/pipelines/start-file`,
      {
        method: 'POST',
        headers: client.headers,
        body: JSON.stringify({
          file: absPath,
          input: input ?? {},
          ...(configPath !== null && { configPath }),
        }),
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

    let terminalSeen = false
    let watchdog: NodeJS.Timeout | undefined

    try {
      // 5-minute hard cap on the live tail. A run that streams nothing
      // for longer than this is treated as stuck — the gateway-side
      // heartbeat fires every 15s, so a healthy stream resets via the
      // ping. We re-arm the watchdog on each chunk in the SSE loop.
      let onWatchdog: () => void = () => {}
      const armWatchdog = (): void => {
        if (watchdog !== undefined) clearTimeout(watchdog)
        watchdog = setTimeout(onWatchdog, 5 * 60_000)
        watchdog.unref?.()
      }
      onWatchdog = () => sseAbort.abort()
      armWatchdog()

      const stream = openSse(
        `${client.discovery.url}/runs/${started.runId}/stream`,
        client.headers,
        sseAbort.signal,
      )
      // When the wait step has its own timeoutMs we want to give the
      // gateway-side wait timer a chance to fire (-> run.failed +
      // WAIT_TIMEOUT). Without a stated timeout we still allow a short
      // grace before declaring the run paused so a fast-resuming flow
      // doesn't race us. Tuned so the existing wait-timeout fixture
      // (50ms) completes naturally.
      let pauseGraceTimer: NodeJS.Timeout | undefined
      let pausedNoInteractive = false
      const armPauseGrace = (waitTimeoutMs: number | undefined): void => {
        const window = (waitTimeoutMs ?? 0) + 1_000
        if (pauseGraceTimer !== undefined) clearTimeout(pauseGraceTimer)
        pauseGraceTimer = setTimeout(() => {
          pausedNoInteractive = true
          sseAbort.abort()
        }, window)
        pauseGraceTimer.unref?.()
      }

      try {
        for await (const ev of stream) {
          armWatchdog()
          if (ev.event === 'ping') continue
          renderEvent(ev, eventMode, io)
          const waitResult = await maybeHandleWait(ev, started.runId, client, io)
          if (waitResult === 'resumed') {
            if (pauseGraceTimer !== undefined) clearTimeout(pauseGraceTimer)
            pauseGraceTimer = undefined
            continue
          }
          if (waitResult === 'cant-prompt') {
            const payload =
              typeof ev.data === 'object' && ev.data !== null
                ? (ev.data as { timeoutMs?: number })
                : undefined
            armPauseGrace(payload?.timeoutMs)
            continue
          }
          const type =
            ev.event !== 'message'
              ? ev.event
              : ((ev.data as { type?: string } | undefined)?.type ?? 'message')
          if (type === 'run.completed' || type === 'run.failed' || type === 'run.cancelled') {
            terminalSeen = true
            break
          }
        }
      } finally {
        if (pauseGraceTimer !== undefined) clearTimeout(pauseGraceTimer)
      }
      // If the grace timer fired and the stream aborted, fall through
      // to the GET /runs/:id below where Run.waiting drives RUN_PAUSED.
      if (pausedNoInteractive) {
        // intentional: status check below handles the report.
      }
    } catch (err) {
      // openSse throws on connection error; fall through to the
      // GET /runs/:id below which can still report the final state.
      if (eventMode === 'human') {
        const detail = err instanceof Error ? err.message : String(err)
        io.stderr.write(`> stream interrupted: ${safeForTty(detail)} — fetching final state\n`)
      }
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog)
    }

    await waitForCancelRequest()

    // Even when the stream delivered a terminal event, fetch the final
    // Run record so we have authoritative output / error / status. Terminal
    // SSE can arrive before final persistence has flushed audit/store writes,
    // so poll briefly for a complete terminal snapshot.
    let run: Run<unknown, unknown>
    const shouldPollFinalState = cancelPromise !== undefined || terminalSeen
    const stateDeadline = shouldPollFinalState ? Date.now() + 5_000 : 0
    for (;;) {
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
      const completeTerminalSnapshot =
        run.status === 'completed' ||
        run.status === 'cancelled' ||
        run.status === 'waiting' ||
        (run.status === 'failed' && run.error !== undefined)
      if (!shouldPollFinalState || completeTerminalSnapshot || Date.now() >= stateDeadline) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
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
    if (run.status === 'failed') {
      if (eventMode === 'human') {
        const prefix = run.error?.name ? `${safeForTty(run.error.name)}: ` : ''
        io.stderr.write(
          `> failed (runId=${run.runId}): ${prefix}${safeForTty(run.error?.message ?? 'unknown')}\n`,
        )
      }
      return { exitCode: mapRunErrorToExit(run.error?.name), run }
    }
    // Run.waiting set means the wait/resume prompt was never driven
    // (e.g. --events=none or piped stdin without a TTY for input).
    // Surface the curl recipe so scripts can still drive resume.
    //
    if (run.waiting !== undefined) {
      io.stderr.write(
        [
          `> paused (runId=${run.runId}): workflow is awaiting input at ${run.waiting.stepId}.`,
          '  Resume directly on the gateway:',
          `    curl -X POST ${client.discovery.url}/runs/${run.runId}/resume \\`,
          "      -H 'content-type: application/json' \\",
          `      -d '{"output": <your-json-here>}'`,
          '',
        ].join('\n'),
      )
      return { exitCode: EXIT.RUN_PAUSED, run }
    }
    if (!terminalSeen && eventMode === 'human') {
      io.stderr.write(`> stream ended without a terminal event (runId=${run.runId})\n`)
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
 * wait and was handled (so the caller skips terminal-event detection).
 *
 * Schema-side validation is gateway-side: we pass through whatever the
 * user typed and let the gateway's wait step surface a validation
 * failure as a step error if needed.
 */
type WaitOutcome = 'not-wait' | 'resumed' | 'cant-prompt'

async function maybeHandleWait(
  ev: SseEvent,
  runId: string,
  client: { discovery: { url: string }; headers: Record<string, string> },
  io: RunCommandIO,
): Promise<WaitOutcome> {
  const dataType =
    typeof ev.data === 'object' && ev.data !== null
      ? (ev.data as { type?: string }).type
      : undefined
  if (ev.event !== 'run.waiting' && dataType !== 'run.waiting') {
    return 'not-wait'
  }
  const payload = (typeof ev.data === 'object' && ev.data !== null ? ev.data : {}) as {
    stepId?: string
    message?: string
    timeoutMs?: number
  }
  const req: SimpleWaitRequest = { stepId: payload.stepId ?? '(wait)' }
  if (payload.message !== undefined) req.message = payload.message
  if (payload.timeoutMs !== undefined) req.timeoutMs = payload.timeoutMs

  if (!hasInteractiveResumeInput(io)) {
    return 'cant-prompt'
  }

  let value: unknown
  try {
    value = await promptForWaitInput(req, io)
  } catch (err) {
    if (err instanceof CliError && (err.code === 'wait-timeout' || err.code === 'wait-cancelled')) {
      io.stderr.write(`error: ${err.message}\n`)
      return 'cant-prompt'
    }
    throw err
  }

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
  return 'resumed'
}

/**
 * Render a single SSE event to stderr. Mirrors the human/json formats
 * the pre-refactor in-process bus produced.
 *
 * @internal Exported for unit tests; not part of the public CLI surface.
 */
export function renderEvent(ev: SseEvent, mode: 'human' | 'json' | 'none', io: RunCommandIO): void {
  if (mode === 'none') return
  // The initial run.state frame from the gateway carries a Run snapshot,
  // not a RunEvent — skip it in user-facing output.
  if (ev.event === 'run.state') return
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
    case 'step.partial': {
      // Streaming text from an agent step. Each event carries a non-cumulative
      // delta; mirror TUI behavior and write straight through to stderr with no
      // prefix so output reads as a single growing message.
      const delta = (data as { delta?: unknown }).delta
      if (typeof delta === 'string' && delta !== '') {
        io.stderr.write(safeForTty(delta))
      }
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
    case BackendCapabilityError.name:
      return EXIT.BACKEND_CAPABILITY
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
  let inputClosed = false
  const timer =
    request.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          controller.abort()
        }, request.timeoutMs)
  timer?.unref?.()
  // Input-stream end before any non-empty response means we have no
  // interactive source — abort the prompt so the caller can fall back
  // to the EXIT.RUN_PAUSED path. This covers the test-harness case of
  // an empty Readable injected as stdin.
  const onClose = () => {
    inputClosed = true
    controller.abort()
  }
  const inputAny = promptIo.input as NodeJS.EventEmitter
  inputAny.once('end', onClose)
  inputAny.once('close', onClose)
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
      if (inputClosed && raw.trim().length === 0) {
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
    inputAny.removeListener('end', onClose)
    inputAny.removeListener('close', onClose)
    rl.close()
    promptIo.close()
  }
}

/**
 * True if the CLI has a viable interactive input source for the wait
 * prompt — a TTY (`/dev/tty` accessible) or an injected stdin that
 * presents as a TTY in the test harness. Non-TTY non-piped invocations
 * (CI, scripts piping empty stdin) skip the prompt and fall through to
 * the EXIT.RUN_PAUSED + curl recipe path.
 */
function hasInteractiveResumeInput(io: RunCommandIO): boolean {
  if (isTtyStream(io.stdin)) return true
  // Injected stdin (e.g. test harness passing a Readable) is a usable
  // input source as long as it isn't process.stdin itself in a non-tty
  // environment — the latter is the "piped empty stdin from CI"
  // scenario where we MUST fall through to EXIT.RUN_PAUSED so scripts
  // don't hang.
  if (io.stdin !== process.stdin) return true
  if (process.platform !== 'win32' && io.stderr === process.stderr && process.stderr.isTTY) {
    try {
      accessSync('/dev/tty', fsConstants.R_OK | fsConstants.W_OK)
      return true
    } catch {
      return false
    }
  }
  return false
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
