/**
 * SKILL.md schema and parser.
 *
 * A skill is a small reusable capability bundle: a markdown body (the
 * skill prompt / instructions) prefixed with optional YAML frontmatter
 * declaring the skill's id, description, permissions hints, and
 * optionally the workflow steps that may invoke it.
 *
 * Phase 3 ships the parser + types only. Wiring to agent steps lands in
 * Phase 8 alongside the coding-agent supervisor.
 */

import { parseDocument } from 'yaml'

export interface Skill {
  id: string
  description?: string
  /** Optional restriction: only these workflow ids may invoke this skill. */
  allowedWorkflows?: readonly string[]
  /** Free-form metadata pulled from frontmatter (forward-compatible). */
  metadata: Readonly<Record<string, unknown>>
  /** The markdown body of the skill (everything after the frontmatter). */
  body: string
  /** Absolute path the skill was loaded from. */
  source: string
}

/**
 * Format a skill as a markdown block for injection into an agent system prompt.
 * Includes description, compatibility, and allowed-tools hints from frontmatter
 * so the agent has the full context the skill author intended.
 */
export function formatSkillBlock(skill: Skill): string {
  const lines: string[] = [`## Skill: ${skill.id}`]
  if (skill.description) lines.push(`_${skill.description}_`)
  const compat = skill.metadata.compatibility
  if (typeof compat === 'string' && compat) lines.push(`**Compatibility:** ${compat}`)
  const allowedTools = skill.metadata['allowed-tools']
  if (typeof allowedTools === 'string' && allowedTools)
    lines.push(`**Allowed tools:** ${allowedTools}`)
  lines.push('', skill.body)
  return lines.join('\n')
}

export class SkillParseError extends Error {
  constructor(
    message: string,
    readonly source: string,
  ) {
    super(`${source}: ${message}`)
    this.name = 'SkillParseError'
  }
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

/**
 * Parse a SKILL.md document. The frontmatter parser is intentionally tiny
 * around the YAML library: fenced frontmatter is required, while the YAML
 * parser owns value parsing and syntax validation.
 */
export function parseSkill(source: string, raw: string): Skill {
  const trimmed = raw.replace(/^﻿/, '')
  const match = trimmed.match(FRONTMATTER_RE)
  if (!match) {
    throw new SkillParseError('missing YAML frontmatter delimited by ---', source)
  }
  const [, fm, body] = match
  if (fm === undefined || body === undefined) {
    throw new SkillParseError('malformed frontmatter', source)
  }
  const metadata = parseFrontmatter(fm, source)
  const id = readString(metadata, 'id')
  if (id === null) {
    throw new SkillParseError('frontmatter must include `id: <skill-id>`', source)
  }
  const description = readString(metadata, 'description') ?? undefined
  const allowedWorkflows = readStringArray(metadata, 'allowedWorkflows') ?? undefined
  return {
    id,
    ...(description !== undefined && { description }),
    ...(allowedWorkflows !== undefined && { allowedWorkflows }),
    metadata: Object.freeze({ ...metadata }),
    body: body.trim(),
    source,
  }
}

function parseFrontmatter(fm: string, source: string): Record<string, unknown> {
  const doc = parseDocument(fm)
  const [error] = doc.errors
  if (error !== undefined) {
    throw new SkillParseError(`malformed frontmatter: ${error.message}`, source)
  }
  const metadata = doc.toJSON()
  if (!isRecord(metadata)) {
    throw new SkillParseError('frontmatter must be a YAML mapping', source)
  }
  return metadata
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key]
  return typeof v === 'string' && v !== '' ? v : null
}

function readStringArray(meta: Record<string, unknown>, key: string): string[] | null {
  const v = meta[key]
  if (!Array.isArray(v)) return null
  const all = v.every((x) => typeof x === 'string')
  return all ? (v as string[]) : null
}
