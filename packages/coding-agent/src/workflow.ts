/**
 * The `@skelm/coding-agent` workflow factory.
 *
 * Given a workspace path and a task, this builds a project-agnostic pipeline
 * that:
 *   1. reads the project's own instructions + infers its stack/validation
 *      (deterministic `code` step, no LLM),
 *   2. plans, edits, and validates the change on the native `@skelm/agent`
 *      backend under default-deny, workspace-scoped permissions and a
 *      harness safety budget,
 *   3. summarizes the result (deterministic `code` step).
 *
 * Opening a PR is gated behind explicit `pr.enabled` config AND the
 * executable/network permissions the profile declares; it is OFF by default.
 *
 * Audit of commands / files / model-tool actions is owned by the gateway —
 * this package adds no audit writer. The agent step's tool dispatch and
 * permission denials surface as the gateway's normal `tool.call` /
 * `tool.result` / `permission.denied` events.
 */

import { type Context, agent, code, pipeline } from '@skelm/core'
import type { Pipeline } from '@skelm/core'

import type { CodingAgentConfig } from './config.js'
import { resolveCodingAgentConfig } from './config.js'
import { type ProjectInstructions, readProjectInstructions } from './instructions.js'
import { buildAgentPermissions } from './permissions.js'
import { buildImplementPrompt } from './prompt.js'

export interface CodingAgentInput {
  /** Natural-language description of the change to make. */
  readonly task: string
}

export interface CodingAgentOutput {
  readonly task: string
  readonly stack: string
  readonly instructionSources: readonly string[]
  /** The agent's final summary text. */
  readonly summary: string
  /** Whether PR-opening was permitted for this run. */
  readonly prEnabled: boolean
}

const STEP_READ = 'read-instructions'
const STEP_IMPLEMENT = 'implement'

/**
 * Build a runnable coding-agent pipeline bound to one workspace + profile.
 * The returned `Pipeline` is a plain immutable value; run it with
 * `runPipeline(wf, { task }, { backends })` or host it on the gateway.
 */
export function createCodingAgentWorkflow(
  config: CodingAgentConfig,
): Pipeline<CodingAgentInput, CodingAgentOutput> {
  const cfg = resolveCodingAgentConfig(config)
  const permissions = buildAgentPermissions(cfg.workspace, cfg.profile, cfg.pr)

  return pipeline<CodingAgentInput, CodingAgentOutput>({
    id: 'coding-agent',
    description: 'Project-agnostic coding agent: read instructions, edit, validate.',
    steps: [
      code({
        id: STEP_READ,
        run: async (): Promise<ProjectInstructions> => readProjectInstructions(cfg.workspace),
      }),

      agent({
        id: STEP_IMPLEMENT,
        backend: cfg.backend,
        permissions,
        maxTurns: cfg.maxTurns,
        ...(cfg.timeoutMs !== undefined && { timeoutMs: cfg.timeoutMs }),
        prompt: (ctx: Context): string => {
          const input = ctx.input as CodingAgentInput
          const instructions = ctx.get<ProjectInstructions>(STEP_READ)
          return buildImplementPrompt({
            task: input.task,
            workspace: cfg.workspace,
            instructions: instructions ?? {
              stack: 'unknown',
              instructions: '(instructions step produced no output)',
              sources: [],
              inferredValidation: [],
            },
            profile: cfg.profile,
            prEnabled: cfg.pr.enabled,
          })
        },
      }),
    ],
    finalize: (ctx): CodingAgentOutput => {
      const input = ctx.input as CodingAgentInput
      const instructions = ctx.get<ProjectInstructions>(STEP_READ)
      const summary = ctx.get<{ text?: string }>(STEP_IMPLEMENT)
      return {
        task: input.task,
        stack: instructions?.stack ?? 'unknown',
        instructionSources: instructions?.sources ?? [],
        summary: typeof summary?.text === 'string' ? summary.text : '',
        prEnabled: cfg.pr.enabled,
      }
    },
  })
}
