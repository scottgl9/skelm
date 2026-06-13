/**
 * Assemble the implement-stage prompt from the task and the project's own
 * instructions. Pure string building — no LLM, no IO.
 */

import type { ProjectProfile } from './config.js'
import type { ProjectInstructions } from './instructions.js'

export interface BuildPromptInput {
  readonly task: string
  readonly workspace: string
  readonly instructions: ProjectInstructions
  readonly profile: ProjectProfile
  readonly prEnabled: boolean
}

function describeValidation(input: BuildPromptInput): string {
  const fromProfile = input.profile.validationCommands
  const commands =
    fromProfile !== undefined && fromProfile.length > 0
      ? fromProfile
      : input.instructions.inferredValidation
  if (commands.length === 0) {
    return 'No validation command is configured; infer one from the project instructions above and run it.'
  }
  return commands.map((c) => `- \`${c.join(' ')}\``).join('\n')
}

/**
 * Build the agent's instruction prompt. Spells out the bounded loop: read,
 * plan, edit via the file-edit tools, run focused tests, then full
 * validation through the allowed executables, summarize the diff. Tells the
 * agent explicitly that it may only touch files under the workspace and may
 * only run the allowed commands, and whether opening a PR is permitted.
 */
export function buildImplementPrompt(input: BuildPromptInput): string {
  const focused =
    input.profile.focusedTestCommand !== undefined
      ? `\nWhen possible, first run a focused test: \`${input.profile.focusedTestCommand.join(' ')}\`.`
      : ''

  const prClause = input.prEnabled
    ? 'After validation passes you MAY commit on a branch and open a pull request, but only using the executables and network host already granted to you.'
    : 'Do NOT open a pull request, push, or commit. Leave your changes in the working tree for review.'

  return [
    `You are a coding agent working inside the repository at ${input.workspace}.`,
    '',
    'Project instructions (read these — they are the source of truth for this repo):',
    '',
    input.instructions.instructions,
    '',
    `Detected stack: ${input.instructions.stack}.`,
    '',
    'Task:',
    input.task,
    '',
    'Follow this bounded loop:',
    '1. Read the relevant files to understand the change.',
    '2. Plan a minimal, focused implementation.',
    '3. Edit code using your file-edit tools. You may only read and write files',
    `   under ${input.workspace}; any path outside it will be denied.`,
    `4. Run validation using ONLY the allowed commands:${focused}`,
    describeValidation(input),
    '   You may only run the executables granted to you; other binaries are denied.',
    '5. If validation fails, fix and re-run. Do not give up silently.',
    '',
    prClause,
    '',
    'When done, reply with a short summary of what you changed and the validation result.',
  ].join('\n')
}
