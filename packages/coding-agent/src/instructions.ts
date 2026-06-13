/**
 * Read a project's own instructions and infer its stack + validation
 * commands. Pure, deterministic, side-effect-free apart from reading files
 * inside the workspace — no LLM, no network, no exec. Runs in a `code()`
 * step so the result is a recorded, replayable step output.
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

/** Instruction files probed, in priority order. */
export const INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'CONTRIBUTING.md',
  'docs/README.md',
] as const

/** Manifest files used to infer the stack and a default validation command. */
const STACK_PROBES: ReadonlyArray<{
  file: string
  stack: string
  validation: readonly (readonly string[])[]
}> = [
  { file: 'pnpm-lock.yaml', stack: 'node-pnpm', validation: [['pnpm', 'test']] },
  { file: 'package-lock.json', stack: 'node-npm', validation: [['npm', 'test']] },
  { file: 'package.json', stack: 'node', validation: [['npm', 'test']] },
  { file: 'Cargo.toml', stack: 'rust', validation: [['cargo', 'test']] },
  { file: 'go.mod', stack: 'go', validation: [['go', 'test', './...']] },
  { file: 'pyproject.toml', stack: 'python', validation: [['pytest']] },
]

export interface ProjectInstructions {
  /** Detected stack identifier, or 'unknown' when no manifest matched. */
  readonly stack: string
  /** Concatenated instruction text from the files that were found. */
  readonly instructions: string
  /** Which instruction files (workspace-relative) were read. */
  readonly sources: readonly string[]
  /**
   * Inferred validation commands when the caller's profile did not supply
   * any. argv arrays; never a shell string. Empty when nothing was inferred.
   */
  readonly inferredValidation: readonly (readonly string[])[]
}

/**
 * Bound a workspace-relative path to inside the workspace. Rejects absolute
 * inputs and `..` escapes — the reader only ever touches files under the
 * declared workspace, even though it runs without the agent's fsRead gate.
 */
function safeJoin(workspace: string, rel: string): string {
  if (isAbsolute(rel)) throw new Error(`instructions: refusing absolute path "${rel}"`)
  const resolved = join(workspace, rel)
  const back = relative(workspace, resolved)
  if (back.startsWith('..') || isAbsolute(back)) {
    throw new Error(`instructions: path "${rel}" escapes workspace`)
  }
  return resolved
}

async function tryRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return undefined
  }
}

async function exists(path: string): Promise<boolean> {
  return (await tryRead(path)) !== undefined
}

/**
 * Read instruction files and infer the stack/validation. `maxBytesPerFile`
 * caps each file so a giant README cannot blow the agent's context budget.
 */
export async function readProjectInstructions(
  workspace: string,
  opts: { maxBytesPerFile?: number } = {},
): Promise<ProjectInstructions> {
  const cap = opts.maxBytesPerFile ?? 16_000
  const sources: string[] = []
  const chunks: string[] = []
  for (const file of INSTRUCTION_FILES) {
    const body = await tryRead(safeJoin(workspace, file))
    if (body === undefined) continue
    sources.push(file)
    const clipped = body.length > cap ? `${body.slice(0, cap)}\n… (truncated)` : body
    chunks.push(`### ${file}\n\n${clipped}`)
  }

  let stack = 'unknown'
  let inferredValidation: readonly (readonly string[])[] = []
  for (const probe of STACK_PROBES) {
    if (await exists(safeJoin(workspace, probe.file))) {
      stack = probe.stack
      inferredValidation = probe.validation
      break
    }
  }

  return {
    stack,
    instructions: chunks.join('\n\n') || '(no project instruction files found)',
    sources,
    inferredValidation,
  }
}
