/**
 * @skelm/coding-agent — project-agnostic coding-agent workflow package.
 *
 * Built on the native `@skelm/agent` backend. Given a workspace path and a
 * task, the workflow reads the project's own instructions, plans a bounded
 * change, edits code with the agent's file-edit tools, runs validation
 * through operator-defined executable profiles (never arbitrary exec), and
 * summarizes the result. Opening a PR is OFF by default and gated behind
 * explicit config plus the permissions it requires.
 *
 * Permissions are DECLARED on the agent step and default-deny: `fsRead` /
 * `fsWrite` are scoped to the workspace, executables come only from named
 * profiles, and network is denied unless an explicit host allowlist is given.
 * The gateway owns audit; this package adds no second audit writer.
 */

export {
  type CodingAgentBudget,
  type CodingAgentConfig,
  DEFAULT_BASE_BRANCH,
  DEFAULT_MAX_TURNS,
  type ProjectProfile,
  type PullRequestConfig,
  resolveCodingAgentConfig,
} from './config.js'
export {
  INSTRUCTION_FILES,
  type ProjectInstructions,
  readProjectInstructions,
} from './instructions.js'
export { buildAgentPermissions } from './permissions.js'
export { type BuildPromptInput, buildImplementPrompt } from './prompt.js'
export {
  type CodingAgentInput,
  type CodingAgentOutput,
  createCodingAgentWorkflow,
} from './workflow.js'
