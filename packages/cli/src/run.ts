import { readFile } from 'node:fs/promises'
import { SchemaValidationError, runPipeline } from '@skelm/core'
import type { Run } from '@skelm/core'
import { EXIT, type ExitCode } from './exit-codes.js'
import { CliError, loadWorkflowFromFile } from './load-workflow.js'

export interface RunCommandArgs {
  workflowPath: string
  input?: string
  inputFile?: string
  inputStdin?: boolean
  output?: string
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

  io.stderr.write(`> running ${workflow.id}\n`)
  const run = await runPipeline(workflow, input)

  if (run.status === 'completed') {
    const json = `${JSON.stringify(run.output)}\n`
    io.stdout.write(json)
    io.stderr.write(`> completed (runId=${run.runId})\n`)
    return { exitCode: EXIT.OK, run }
  }

  if (run.status === 'cancelled') {
    io.stderr.write(`> cancelled (runId=${run.runId})\n`)
    return { exitCode: EXIT.CANCELLED, run }
  }

  io.stderr.write(`> failed (runId=${run.runId}): ${run.error?.message ?? 'unknown'}\n`)
  if (run.error?.name === SchemaValidationError.name) {
    return { exitCode: EXIT.SCHEMA_VALIDATION, run }
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
