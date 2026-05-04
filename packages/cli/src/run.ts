import { accessSync, createReadStream, createWriteStream, constants as fsConstants } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  EventBus,
  RunCancelledError,
  SchemaValidationError,
  type WaitRequest,
  WaitTimeoutError,
  runPipeline,
} from '@skelm/core'
import type { Run } from '@skelm/core'
import { applyAgentDefinitions } from './agent-defs.js'
import { applyConfiguredBackends, buildBackendRegistry } from './backends.js'
import { EXIT, type ExitCode } from './exit-codes.js'
import { loadSkelmConfig } from './load-config.js'
import { CliError, loadWorkflowFromFile } from './load-workflow.js'
import { closeRunStore, createRunStore, createWorkspaceManager } from './store.js'

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
 * Implementation of `skelm run <workflow>`. Loads the workflow module,
 * resolves the input (from --input / --input-file / --input-stdin),
 * runs the pipeline, prints the final output to stdout, and writes
 * progress to stderr.
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

  let workflow: Awaited<ReturnType<typeof loadWorkflowFromFile>>
  try {
    workflow = await loadWorkflowFromFile(workflowPath)
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr.write(`error: ${err.message}\n`)
      return { exitCode: EXIT.CLI_ERROR }
    }
    throw err
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
  const bus = new EventBus()
  if (eventMode === 'json') {
    bus.subscribe((event) => {
      io.stderr.write(`${JSON.stringify(event)}\n`)
    })
  } else if (eventMode === 'human') {
    bus.subscribe((event) => {
      switch (event.type) {
        case 'run.started':
          io.stderr.write(`> running ${workflow.id}\n`)
          break
        case 'step.start':
          io.stderr.write(`  - ${event.stepId} (${event.kind})\n`)
          break
        case 'step.error':
          io.stderr.write(`  ! ${event.stepId}: ${event.error.message}\n`)
          break
        default:
          break
      }
    })
  }

  const workflowDir = dirname(resolve(process.cwd(), workflowPath))
  const { config } = await loadSkelmConfig({ fromDir: workflowDir })
  const resolvedWorkflow = applyConfiguredBackends(
    applyAgentDefinitions(workflow, workflowDir),
    config,
  )
  const backends = await buildBackendRegistry(config, resolvedWorkflow)
  const store = createRunStore(config)
  const workspaceManager = createWorkspaceManager(config)
  const controller = new AbortController()

  const run = await (async () => {
    try {
      return await runPipeline(resolvedWorkflow, input, {
        signal: controller.signal,
        events: bus,
        store,
        stateStore: store,
        workflowPath: resolve(process.cwd(), workflowPath),
        ...(config.defaults?.permissions !== undefined && {
          defaultPermissions: config.defaults.permissions,
        }),
        ...(config.defaults?.permissionProfiles !== undefined && {
          permissionProfiles: config.defaults.permissionProfiles,
        }),
        workspaceManager,
        ...(backends !== undefined && { backends }),
        waitForInput: async (request) => await promptForWaitInput(request, io),
      })
    } finally {
      closeRunStore(store)
    }
  })()

  if (run.status === 'completed') {
    const json = `${JSON.stringify(run.output)}\n`
    io.stdout.write(json)
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
    io.stderr.write(`> failed (runId=${run.runId}): ${run.error?.message ?? 'unknown'}\n`)
  }
  if (run.error?.name === SchemaValidationError.name) {
    return { exitCode: EXIT.SCHEMA_VALIDATION, run }
  }
  if (run.error?.name === WaitTimeoutError.name) {
    return { exitCode: EXIT.WAIT_TIMEOUT, run }
  }
  return { exitCode: EXIT.RUN_FAILED, run }
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

async function promptForWaitInput(request: WaitRequest, io: RunCommandIO): Promise<unknown> {
  const promptIo = openPromptIo(io)
  const promptSignal = createPromptSignal(request)
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
        raw = await rl.question('resume JSON> ', { signal: promptSignal.signal })
      } catch (error) {
        if (promptSignal.timedOut) {
          throw new WaitTimeoutError(
            `wait(${request.stepId}) timed out after ${request.timeoutMs ?? 0}ms`,
          )
        }
        if (request.signal.aborted) {
          throw new RunCancelledError()
        }
        const detail = error instanceof Error ? error.message : String(error)
        throw new RunCancelledError(`wait(${request.stepId}) input cancelled (${detail})`)
      }

      const trimmed = raw.trim()
      if (trimmed.length === 0) {
        promptIo.output.write('! enter JSON (use null for an empty value)\n')
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        promptIo.output.write(`! invalid JSON: ${detail}\n`)
        continue
      }

      if (request.outputSchema !== undefined) {
        const validation = await validateWaitInput(request, parsed)
        if (!validation.ok) {
          promptIo.output.write(`! ${validation.message}\n`)
          continue
        }
        return validation.value
      }

      return parsed
    }
  } finally {
    promptSignal.dispose()
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

function createPromptSignal(request: WaitRequest): {
  signal: AbortSignal
  timedOut: boolean
  dispose: () => void
} {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort()
  request.signal.addEventListener('abort', onAbort, { once: true })
  const timer =
    request.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          controller.abort()
        }, request.timeoutMs)
  timer?.unref?.()
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut
    },
    dispose: () => {
      request.signal.removeEventListener('abort', onAbort)
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    },
  }
}

async function validateWaitInput(
  request: Pick<WaitRequest, 'outputSchema'>,
  value: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const schema = request.outputSchema
  if (schema === undefined) return { ok: true, value }
  const result = await schema['~standard'].validate(value)
  if ('issues' in result && result.issues !== undefined) {
    return {
      ok: false,
      message: formatSchemaIssues(
        result.issues as ReadonlyArray<{
          message: string
          path: ReadonlyArray<unknown> | undefined
        }>,
      ),
    }
  }
  return { ok: true, value: result.value }
}

function formatSchemaIssues(
  issues: ReadonlyArray<{ message: string; path: ReadonlyArray<unknown> | undefined }>,
): string {
  return issues
    .map((issue) => {
      const path =
        issue.path === undefined
          ? ''
          : issue.path
              .map((segment) => {
                if (typeof segment === 'object' && segment !== null && 'key' in segment) {
                  return String((segment as { key: unknown }).key)
                }
                return String(segment)
              })
              .join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('; ')
}

function isTtyStream(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
  return 'isTTY' in stream && stream.isTTY === true
}
