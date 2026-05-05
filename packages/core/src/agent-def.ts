import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/**
 * A loaded agent definition. The `spec` on an agent step (e.g.
 * `agentDef: './agents/jira-agent'`) resolves to a directory containing
 * an `AGENTS.md` (instructions, required) and an optional `SOUL.md`
 * (persona). Backends prepend `soul` + `instructions` to the agent's
 * system prompt.
 */
export interface AgentDefinition {
  readonly id: string
  readonly instructions: string
  readonly soul?: string
  readonly source: string
}

export interface LoadAgentDefinitionOptions {
  /** Absolute path to the workflow file (or its directory). Required when `spec` is relative. */
  workflowPath?: string
  /** Base path that the resolved directory must stay under (path-traversal guard). Defaults to the workflow directory. */
  agentDefRoot?: string
}

export class AgentDefinitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentDefinitionError'
  }
}

/**
 * Resolve and load an agent definition from disk.
 *
 * Layout (with `spec = './agents/jira-agent'`, workflow file
 * `/proj/flows/foo.workflow.ts`):
 *
 *   /proj/flows/agents/jira-agent/AGENTS.md   — required
 *   /proj/flows/agents/jira-agent/SOUL.md     — optional
 *
 * Throws `AgentDefinitionError` if the resolved path escapes `agentDefRoot`,
 * or if `AGENTS.md` is missing.
 */
export async function loadAgentDefinition(
  spec: string,
  opts: LoadAgentDefinitionOptions = {},
): Promise<AgentDefinition> {
  if (spec.length === 0) {
    throw new AgentDefinitionError('agentDef spec must be a non-empty string')
  }
  const workflowDir = opts.workflowPath !== undefined ? dirname(opts.workflowPath) : undefined
  const root = opts.agentDefRoot ?? workflowDir
  let dir: string
  if (isAbsolute(spec)) {
    dir = spec
  } else if (workflowDir !== undefined) {
    dir = resolve(workflowDir, spec)
  } else if (opts.agentDefRoot !== undefined) {
    dir = resolve(opts.agentDefRoot, spec)
  } else {
    throw new AgentDefinitionError(
      `agentDef "${spec}" is relative but no workflowPath or agentDefRoot was provided`,
    )
  }
  if (root !== undefined) {
    const rel = relative(root, dir)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new AgentDefinitionError(
        `agentDef "${spec}" resolves outside of agentDefRoot (${root})`,
      )
    }
  }
  const instructionsPath = resolve(dir, 'AGENTS.md')
  let instructions: string
  try {
    instructions = await fs.readFile(instructionsPath, 'utf8')
  } catch (err) {
    throw new AgentDefinitionError(
      `agentDef "${spec}" is missing AGENTS.md at ${instructionsPath}: ${(err as Error).message}`,
    )
  }
  const soulPath = resolve(dir, 'SOUL.md')
  let soul: string | undefined
  try {
    soul = await fs.readFile(soulPath, 'utf8')
  } catch {
    soul = undefined
  }
  const id = dir.split('/').pop() ?? spec
  const def: AgentDefinition = {
    id,
    instructions,
    ...(soul !== undefined && { soul }),
    source: dir,
  }
  return Object.freeze(def)
}
