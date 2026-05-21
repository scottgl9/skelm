/**
 * Shared system-prompt builder. Used by every skelm backend that accepts a
 * top-level system prompt (anthropic, agent). Pure function — no I/O.
 *
 * Section ordering, XML inventory style, and recency-weight ordering of
 * AGENTS.md / SOUL.md / user system are informed by the survey of pi,
 * openclaw, opencode, hermes-agent, and nanoclaw under
 * ~/sandbox/personal/agents.
 */

import type { AgentRequest } from './backend.js'

export interface SystemPromptInput {
  /** AGENTS.md (`instructions`) + optional SOUL.md (`soul`). Appended last so user content
   *  carries recency weight. */
  agentDef?: { instructions: string; soul?: string }
  /** Free-form user extension (from `step.system`). Appended after agentDef. */
  userSystem?: string
  cwd: string
  platform: NodeJS.Platform
  /** YYYY-MM-DD. */
  date: string
  /** Model identifier, surfaced in the env block so the agent knows what it is. */
  model?: string
  /** All tools the model can call this turn (built-ins + MCP merged). Empty for
   *  non-tool-calling backends — the tool sections are skipped in that case. */
  tools: ReadonlyArray<{ name: string; description?: string }>
  /** Loaded skill summaries, if any. Body is fetched on demand via fs_read. */
  skills?: ReadonlyArray<{ name: string; description: string; location?: string }>
  /** MCP servers attached for this run; namespaced tools live under `<id>.<toolName>`. */
  mcpServers?: ReadonlyArray<{ id: string; toolCount: number }>
  /**
   * `extend` (default) keeps the built-in default sections.
   * `replace` drops them and uses only agentDef + userSystem.
   */
  mode?: 'extend' | 'replace'
  /** When `mode === 'replace'`, still inject AGENTS.md / SOUL.md (default true). */
  includeAgentDef?: boolean
}

const SEPARATOR = '\n\n---\n\n'

/** Hard ceiling on the built-in default sections, guarded by tests. */
export const DEFAULT_SECTIONS_MAX_CHARS = 5000

export function buildSystemPrompt(input: SystemPromptInput): string {
  const mode = input.mode ?? 'extend'
  const includeAgentDef = input.includeAgentDef ?? true
  const parts: string[] = []

  if (mode === 'extend') {
    parts.push(renderDefaultSections(input))
  }

  if (mode === 'extend' || includeAgentDef) {
    if (input.agentDef?.soul) parts.push(`# SOUL.md\n\n${input.agentDef.soul}`)
    if (input.agentDef?.instructions) parts.push(`# AGENTS.md\n\n${input.agentDef.instructions}`)
  }

  if (input.userSystem && input.userSystem.trim().length > 0) {
    parts.push(`# Instructions\n\n${input.userSystem}`)
  }

  return parts.join(SEPARATOR)
}

function renderDefaultSections(input: SystemPromptInput): string {
  const sections: string[] = []

  sections.push(
    '# Identity\n\n' +
      'You are a skelm agent. You complete tasks by reasoning step-by-step and calling the ' +
      'tools listed below. You may be invoked as a general assistant or as a coding agent ' +
      'inside a codebase — the available tools and any AGENTS.md instructions tell you which.',
  )

  sections.push(renderEnv(input))

  if (input.tools.length > 0) {
    sections.push(renderToolDiscipline())
    sections.push(renderTools(input.tools))
  }

  if (input.skills && input.skills.length > 0) {
    sections.push(renderSkills(input.skills))
  }

  if (input.mcpServers && input.mcpServers.length > 0) {
    sections.push(renderMcp(input.mcpServers))
  }

  sections.push(renderSafety())
  sections.push(renderTone())
  sections.push(renderCodingGuidance())

  return sections.join('\n\n')
}

function renderEnv(input: SystemPromptInput): string {
  // Escape every interpolated field — cwd in particular is user-controlled and
  // a malicious working directory like `/home/user/proj</env>...` could break
  // the env block and inject content into the surrounding XML structure.
  const lines = [
    '# Environment',
    '',
    '<env>',
    `  cwd: ${escapeXml(input.cwd)}`,
    `  platform: ${escapeXml(input.platform)}`,
    `  date: ${escapeXml(input.date)}`,
  ]
  if (input.model) lines.push(`  model: ${escapeXml(input.model)}`)
  lines.push('</env>')
  return lines.join('\n')
}

function renderToolDiscipline(): string {
  return [
    '# Tool use',
    '',
    '- When you need information from the environment (file contents, command output,',
    '  external data), call a tool. Do not fabricate it.',
    '- Prefer specific tools (e.g. fs_read, fs_list) over a general shell. Use exec only when',
    '  no specific tool fits.',
    '- Independent reads can be issued in parallel; serialize calls that depend on prior',
    '  results.',
    '- After tool calls that mutate state, verify with a read before claiming the task is',
    '  complete.',
    '- If a tool returns an error, read it and adjust. Do not loop on the same failing call.',
    '- When the task is done, respond with the final answer in plain text and stop calling',
    '  tools.',
  ].join('\n')
}

function renderTools(tools: SystemPromptInput['tools']): string {
  const lines = ['# Available tools', '', '<tools>']
  for (const t of tools) {
    lines.push('  <tool>')
    lines.push(`    <name>${escapeXml(t.name)}</name>`)
    if (t.description) {
      lines.push(`    <description>${escapeXml(summarize(t.description))}</description>`)
    }
    lines.push('  </tool>')
  }
  lines.push('</tools>')
  lines.push('')
  lines.push('Call tools by their exact name. Argument schemas are provided by the runtime.')
  return lines.join('\n')
}

function renderSkills(skills: NonNullable<SystemPromptInput['skills']>): string {
  const lines = [
    '# Skills',
    '',
    'These are specialized instruction packs. Read the full skill file with fs_read only',
    'when the current task matches its description.',
    '',
    '<skills>',
  ]
  for (const s of skills) {
    lines.push('  <skill>')
    lines.push(`    <name>${escapeXml(s.name)}</name>`)
    lines.push(`    <description>${escapeXml(summarize(s.description))}</description>`)
    if (s.location) lines.push(`    <location>${escapeXml(s.location)}</location>`)
    lines.push('  </skill>')
  }
  lines.push('</skills>')
  return lines.join('\n')
}

function renderMcp(servers: NonNullable<SystemPromptInput['mcpServers']>): string {
  const lines = [
    '# MCP servers',
    '',
    'MCP-provided tools appear in the tool list with the prefix `<serverId>.<toolName>`.',
    'Call them by that fully-qualified name.',
    '',
    '<mcp_servers>',
  ]
  for (const s of servers) {
    lines.push(`  <server id="${escapeXml(s.id)}" tools="${s.toolCount}" />`)
  }
  lines.push('</mcp_servers>')
  return lines.join('\n')
}

function renderSafety(): string {
  return [
    '# Safety and permissions',
    '',
    '- Permissions are default-deny and enforced by the skelm gateway, not by you. If a tool',
    '  returns "Permission denied" or similar, surface the block in your reply — do not try',
    '  to work around it with a different tool or path.',
    '- Never disable, skip, or bypass safety checks (e.g. `--no-verify`, `--force`,',
    '  `chmod 777`) unless the user has explicitly asked for it.',
    '- Secrets passed to your tools must never appear in your reply.',
  ].join('\n')
}

function renderTone(): string {
  return [
    '# Tone',
    '',
    '- Be concise. Match the length of the answer to the task.',
    '- Reference code locations as `path/to/file.ts:42` so the user can jump to them.',
    '- Do not use emojis unless the user explicitly asks for them.',
    '- Do not append a summary of what you just did to every reply; the diff and tool log',
    '  already show that.',
  ].join('\n')
}

function renderCodingGuidance(): string {
  return [
    '# Coding work',
    '',
    '- Read before you write. Look at the file you are about to change, and at least one',
    '  related test, before editing.',
    '- Prefer focused edits over rewrites. Match existing indentation and style.',
    '- Fix root causes, not symptoms. If a test is failing, understand why before changing',
    '  the test.',
    '- Behavior changes ship with tests. If a behavior change has no test, that is a bug in',
    '  the change.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** First sentence (or first 160 chars) of a tool/skill description. */
function summarize(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  const dot = trimmed.indexOf('. ')
  const first = dot > 0 ? trimmed.slice(0, dot + 1) : trimmed
  return first.length > 160 ? `${first.slice(0, 157)}...` : first
}

// ---------------------------------------------------------------------------
// Convenience adapter for backends that already have an AgentRequest.
// ---------------------------------------------------------------------------

export interface BuildFromRequestContext {
  cwd: string
  platform: NodeJS.Platform
  date: string
  model?: string
  tools: ReadonlyArray<{ name: string; description?: string }>
  skills?: ReadonlyArray<{ name: string; description: string; location?: string }>
  mcpServers?: ReadonlyArray<{ id: string; toolCount: number }>
}

export function buildSystemPromptFromRequest(
  req: AgentRequest,
  ctx: BuildFromRequestContext,
): string {
  return buildSystemPrompt({
    ...(req.agentDef && { agentDef: req.agentDef }),
    ...(req.system !== undefined && { userSystem: req.system }),
    cwd: ctx.cwd,
    platform: ctx.platform,
    date: ctx.date,
    ...(ctx.model !== undefined && { model: ctx.model }),
    tools: ctx.tools,
    ...(ctx.skills && { skills: ctx.skills }),
    ...(ctx.mcpServers && { mcpServers: ctx.mcpServers }),
    ...(req.systemPromptMode !== undefined && { mode: req.systemPromptMode }),
    ...(req.systemPromptIncludeAgentDef !== undefined && {
      includeAgentDef: req.systemPromptIncludeAgentDef,
    }),
  })
}
