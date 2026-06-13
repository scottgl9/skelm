/**
 * Configuration schema for the `@skelm/coding-agent` workflow package.
 *
 * The workflow is project-agnostic: it is given a workspace path and a
 * task, reads the project's own instructions (AGENTS.md / CLAUDE.md /
 * README), and edits + validates code through the native `@skelm/agent`
 * backend under default-deny, workspace-scoped permissions.
 *
 * Everything privileged is DECLARED here and on the agent step. There is no
 * arbitrary exec: validation runs through named executable profiles the
 * operator defines in `skelm.config.ts` (e.g. `nodeBuild`), while PR-only
 * git/GitHub executables live in a separate opt-in bucket. Opening a PR is
 * OFF by default and only happens when both `pr.enabled` is true AND the
 * resolved permissions grant the executables/network it needs.
 */

/**
 * Per-repo project profile. Captures everything that differs between
 * repositories so the same workflow runs unmodified across projects.
 */
export interface ProjectProfile {
  /**
   * Named executable profiles (from `defaults.executableProfiles` in
   * `skelm.config.ts`) the agent step may use. The workflow only references
   * profiles by name; it can never define or widen one. Default-deny: an
   * empty list means the agent has no executables at all.
   */
  readonly executableProfiles?: readonly string[]
  /**
   * Named executable profiles required only for PR-capable actions such as
   * branch/commit/push/PR creation. These profiles are withheld unless
   * `pr.enabled` is true, so validation executables stay available without
   * implicitly granting PR-capable exec.
   */
  readonly prExecutableProfiles?: readonly string[]
  /**
   * Explicit executable basenames, intersected with the expanded profiles.
   * Use to narrow the active executable profile set; never widens past the
   * profile expansion or the project-default ceiling.
   */
  readonly allowedExecutables?: readonly string[]
  /**
   * Validation commands run by the agent (via the exec tool, gated by the
   * declared executable profiles) after editing. Each is an argv array; no
   * shell is invoked. Example: `[['pnpm', 'test'], ['pnpm', 'build']]`.
   * When omitted the workflow infers a command from the detected stack.
   */
  readonly validationCommands?: readonly (readonly string[])[]
  /**
   * Focused-test command template. When set, the agent runs this before the
   * full validation suite to get fast feedback. argv array.
   */
  readonly focusedTestCommand?: readonly string[]
  /** Branch naming convention used when `pr.enabled`. `${slug}` is substituted. */
  readonly branchPrefix?: string
  /** Base branch a PR targets. Defaults to `main`. */
  readonly baseBranch?: string
  /**
   * Hostnames the agent may reach. Default-deny: omitted means no network.
   * Only relevant when the task or PR step needs egress (e.g. `api.github.com`).
   */
  readonly allowHosts?: readonly string[]
}

/**
 * PR-opt-in settings. Disabled by default. Even when enabled the agent can
 * only open a PR if the resolved permissions grant the required executable
 * profile and network host — `enabled: true` never widens permissions.
 */
export interface PullRequestConfig {
  /** Master switch. Default `false` — the workflow never opens a PR. */
  readonly enabled?: boolean
  /** PR title template. `${task}` is substituted with the task summary. */
  readonly titleTemplate?: string
  /** Draft PRs when true. Default `true` (safer). */
  readonly draft?: boolean
}

/**
 * Run-wide safety budget forwarded to the native agent harness. A SAFETY
 * LIMIT, not a permission — it can only abort a run early, never widen
 * anything. Omit for an unbounded run.
 */
export interface CodingAgentBudget {
  readonly tokenBudget?: number
  readonly maxCostUsd?: number
  readonly maxToolCalls?: number
  readonly maxWallClockMs?: number
}

/** Full configuration for one coding-agent workflow instance. */
export interface CodingAgentConfig {
  /**
   * Absolute path to the repository/workspace the agent operates in. All
   * `fsRead` / `fsWrite` grants are scoped to this path; the agent cannot
   * read or write outside it.
   */
  readonly workspace: string
  /** Backend id of the native `@skelm/agent` backend. Defaults to `agent`. */
  readonly backend?: string
  /** Per-repo profile (executable profiles, validation, branch/PR policy). */
  readonly profile?: ProjectProfile
  /** Harness safety budget. */
  readonly budget?: CodingAgentBudget
  /** PR-opt-in settings. Default OFF. */
  readonly pr?: PullRequestConfig
  /** Cap on agent tool-call turns. Default 40. */
  readonly maxTurns?: number
  /** Wall-clock cap for the agent step, in ms. */
  readonly timeoutMs?: number
}

export const DEFAULT_BASE_BRANCH = 'main'
export const DEFAULT_MAX_TURNS = 40

/**
 * Normalize a raw config into a fully-defaulted shape. Validates the one
 * hard requirement — an absolute workspace path — and freezes the result so
 * downstream steps cannot mutate the security-relevant fields.
 *
 * Throws on a missing/relative workspace because every permission grant is
 * scoped to it; a relative path would make the scope ambiguous.
 */
export function resolveCodingAgentConfig(config: CodingAgentConfig): Required<
  Pick<CodingAgentConfig, 'workspace' | 'backend' | 'maxTurns'>
> & {
  readonly profile: ProjectProfile
  readonly budget: CodingAgentBudget
  readonly pr: Required<Pick<PullRequestConfig, 'enabled' | 'draft'>> & PullRequestConfig
  readonly timeoutMs?: number
} {
  const ws = config.workspace
  if (typeof ws !== 'string' || ws.length === 0) {
    throw new Error('coding-agent: `workspace` is required (absolute path to the repo)')
  }
  if (!ws.startsWith('/')) {
    throw new Error(`coding-agent: \`workspace\` must be an absolute path (got "${ws}")`)
  }
  return Object.freeze({
    workspace: ws,
    backend: config.backend ?? 'agent',
    maxTurns: config.maxTurns ?? DEFAULT_MAX_TURNS,
    profile: Object.freeze({ ...config.profile }),
    budget: Object.freeze({ ...config.budget }),
    pr: Object.freeze({
      enabled: config.pr?.enabled ?? false,
      draft: config.pr?.draft ?? true,
      ...config.pr,
    }),
    ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
  })
}
