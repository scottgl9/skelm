import { accessSync, createReadStream, createWriteStream, constants as fsConstants } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  EnvSecretResolver,
  EventBus,
  PermissionDeniedError,
  RunCancelledError,
  SchemaValidationError,
  StepTimeoutError,
  type WaitRequest,
  WaitTimeoutError,
  runPipeline,
} from '@skelm/core'
import type { Run, SecretResolver } from '@skelm/core'
import {
  ChainAuditWriter,
  FileSecretResolver,
  SkillRegistry,
  createSkillSource,
} from '@skelm/gateway'
import { applyAgentDefinitions } from './agent-defs.js'
import { applyConfiguredBackends, buildBackendRegistry } from './backends.js'
import { EXIT, type ExitCode } from './exit-codes.js'
import { safeForTty } from './internal/safe-text.js'
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
  const bus = createRunEventBus(eventMode, workflow.id, io)

  const workflowDir = dirname(resolve(process.cwd(), workflowPath))
  const { config, projectRoot } = await loadSkelmConfig({ fromDir: workflowDir })
  const secretResolver = buildSecretResolver(config)
  const resolvedWorkflow = applyConfiguredBackends(
    applyAgentDefinitions(workflow, workflowDir),
    config,
  )
  const backends = await buildBackendRegistry(config, resolvedWorkflow, secretResolver)
  const store = createRunStore(config)
  const workspaceManager = createWorkspaceManager(config)
  const controller = new AbortController()

  const skillRegistry = new SkillRegistry({
    projectRoot,
    glob: config.registries?.skills?.glob ?? 'skills/**/SKILL.md',
  })
  await skillRegistry.start()
  const resolvedWorkflowPath = resolve(process.cwd(), workflowPath)
  const skillSource = createSkillSource({
    registry: skillRegistry,
    workflowPath: resolvedWorkflowPath,
  })

  const run = await (async () => {
    try {
      // Wire the chain audit writer so permission denials and tool dispatch
      // events emitted during one-shot `skelm run` actually land in
      // ~/.skelm/audit.jsonl (or $SKELM_STATE_DIR/audit.jsonl). Without this
      // the runner falls back to NoopAuditWriter and the entire jsonl stays
      // empty for CLI-driven runs, even when the runtime publishes the
      // events on the bus.
      const auditPath = join(
        process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm'),
        'audit.jsonl',
      )
      const auditWriter = new ChainAuditWriter(auditPath)
      return await runPipeline(resolvedWorkflow, input, {
        signal: controller.signal,
        events: bus,
        store,
        stateStore: store,
        auditWriter,
        workflowPath: resolvedWorkflowPath,
        ...(config.defaults?.permissions !== undefined && {
          defaultPermissions: config.defaults.permissions,
        }),
        ...(config.defaults?.permissionProfiles !== undefined && {
          permissionProfiles: config.defaults.permissionProfiles,
        }),
        workspaceManager,
        ...(backends !== undefined && { backends }),
        secretResolver,
        skillSource,
        waitForInput: async (request) => await promptForWaitInput(request, io),
      })
    } finally {
      closeRunStore(store)
      await skillRegistry.close()
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
    io.stderr.write(
      `> failed (runId=${run.runId}): ${safeForTty(run.error?.message ?? 'unknown')}\n`,
    )
  }
  return { exitCode: mapRunErrorToExit(run.error?.name), run }
}

function createRunEventBus(
  eventMode: 'human' | 'json' | 'none',
  workflowId: string,
  io: RunCommandIO,
): EventBus {
  const bus = new EventBus()
  if (eventMode === 'json') {
    bus.subscribe((event) => {
      io.stderr.write(`${JSON.stringify(event)}\n`)
    })
    return bus
  }
  if (eventMode === 'human') {
    bus.subscribe((event) => {
      switch (event.type) {
        case 'run.started':
          io.stderr.write(`> running ${workflowId}\n`)
          break
        case 'step.start':
          io.stderr.write(`  - ${safeForTty(event.stepId)} (${event.kind})\n`)
          break
        case 'step.error':
          io.stderr.write(`  ! ${safeForTty(event.stepId)}: ${safeForTty(event.error.message)}\n`)
          break
        default:
          break
      }
    })
  }
  return bus
}

function buildSecretResolver(
  config: Awaited<ReturnType<typeof loadSkelmConfig>>['config'],
): SecretResolver {
  if (config.secrets?.driver === 'file') {
    return new FileSecretResolver(
      config.secrets.file ??
        join(process.env.SKELM_STATE_DIR ?? join(homedir(), '.skelm'), 'secrets.json'),
    )
  }
  return new EnvSecretResolver()
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
