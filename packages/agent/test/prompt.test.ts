import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SECTIONS_MAX_CHARS,
  type SystemPromptInput,
  buildSystemPrompt,
} from '../src/prompt.js'

function baseInput(overrides: Partial<SystemPromptInput> = {}): SystemPromptInput {
  return {
    cwd: '/work/repo',
    platform: 'linux',
    date: '2026-05-15',
    tools: [
      { name: 'fs_read', description: 'Read a file from disk. Returns its content.' },
      { name: 'exec', description: 'Run a shell command. Use sparingly.' },
    ],
    ...overrides,
  }
}

describe('buildSystemPrompt', () => {
  it('renders all default sections when extend mode and minimal input', () => {
    const out = buildSystemPrompt(baseInput())
    expect(out).toContain('# Identity')
    expect(out).toContain('# Environment')
    expect(out).toContain('cwd: /work/repo')
    expect(out).toContain('platform: linux')
    expect(out).toContain('date: 2026-05-15')
    expect(out).toContain('# Tool use')
    expect(out).toContain('# Available tools')
    expect(out).toContain('<name>fs_read</name>')
    expect(out).toContain('# Safety and permissions')
    expect(out).toContain('# Tone')
    expect(out).toContain('# Coding work')
  })

  it('omits skills and mcp sections when not provided', () => {
    const out = buildSystemPrompt(baseInput())
    expect(out).not.toContain('# Skills')
    expect(out).not.toContain('# MCP servers')
  })

  it('renders skills inventory when skills are provided', () => {
    const out = buildSystemPrompt(
      baseInput({
        skills: [
          {
            name: 'greet-formally',
            description: 'Greet users with a formal tone',
            location: '/skills/greet-formally.md',
          },
        ],
      }),
    )
    expect(out).toContain('# Skills')
    expect(out).toContain('<name>greet-formally</name>')
    expect(out).toContain('<location>/skills/greet-formally.md</location>')
  })

  it('renders MCP servers when provided', () => {
    const out = buildSystemPrompt(
      baseInput({
        mcpServers: [{ id: 'github', toolCount: 4 }],
      }),
    )
    expect(out).toContain('# MCP servers')
    expect(out).toContain('server id="github" tools="4"')
  })

  it('appends SOUL.md, AGENTS.md, and user instructions last for recency weight', () => {
    const out = buildSystemPrompt(
      baseInput({
        agentDef: { soul: 'I am calm.', instructions: 'Use the kanban.' },
        userSystem: 'Always answer in haiku.',
      }),
    )
    const soulIdx = out.indexOf('# SOUL.md')
    const agentsIdx = out.indexOf('# AGENTS.md')
    const userIdx = out.indexOf('# Instructions')
    const codingIdx = out.indexOf('# Coding work')
    expect(soulIdx).toBeGreaterThan(codingIdx)
    expect(agentsIdx).toBeGreaterThan(soulIdx)
    expect(userIdx).toBeGreaterThan(agentsIdx)
    expect(out).toContain('Always answer in haiku.')
  })

  it('replace mode drops the default sections', () => {
    const out = buildSystemPrompt(
      baseInput({
        mode: 'replace',
        agentDef: { instructions: 'You are X.' },
        userSystem: 'Do Y.',
      }),
    )
    expect(out).not.toContain('# Identity')
    expect(out).not.toContain('# Tool use')
    expect(out).not.toContain('# Available tools')
    expect(out).toContain('# AGENTS.md')
    expect(out).toContain('# Instructions')
  })

  it('replace mode with includeAgentDef: false drops AGENTS.md/SOUL.md too', () => {
    const out = buildSystemPrompt(
      baseInput({
        mode: 'replace',
        includeAgentDef: false,
        agentDef: { soul: 'soul', instructions: 'instr' },
        userSystem: 'only this',
      }),
    )
    expect(out).not.toContain('# SOUL.md')
    expect(out).not.toContain('# AGENTS.md')
    expect(out).toContain('only this')
  })

  it('XML-escapes dynamically injected tool and skill content', () => {
    const out = buildSystemPrompt(
      baseInput({
        tools: [{ name: 'evil<tool>', description: '"quotes" & <tags>' }],
        skills: [
          {
            name: "skill'name",
            description: 'A & B < C',
            location: '/p/with"quote.md',
          },
        ],
      }),
    )
    expect(out).toContain('<name>evil&lt;tool&gt;</name>')
    expect(out).toContain('&quot;quotes&quot; &amp; &lt;tags&gt;')
    expect(out).toContain('skill&apos;name')
    expect(out).toContain('A &amp; B &lt; C')
    expect(out).toContain('/p/with&quot;quote.md')
  })

  it('default sections fit within the documented char budget', () => {
    const out = buildSystemPrompt(baseInput())
    // Strip any agentDef/userSystem (none here), so out == default sections + separators
    expect(out.length).toBeLessThan(DEFAULT_SECTIONS_MAX_CHARS)
  })

  it('truncates long tool descriptions to keep the inventory compact', () => {
    const long = 'A'.repeat(500)
    const out = buildSystemPrompt(baseInput({ tools: [{ name: 'big', description: long }] }))
    const match = out.match(/<description>(A+\.\.\.)<\/description>/)
    expect(match).not.toBeNull()
    if (match === null) throw new Error('unreachable')
    expect(match[1]?.length ?? 0).toBeLessThanOrEqual(160)
  })

  it('includes model when provided', () => {
    const out = buildSystemPrompt(baseInput({ model: 'qwen3-coder-30b' }))
    expect(out).toContain('model: qwen3-coder-30b')
  })

  it('mentions MCP namespacing convention', () => {
    const out = buildSystemPrompt(baseInput({ mcpServers: [{ id: 'gh', toolCount: 1 }] }))
    expect(out).toContain('<serverId>.<toolName>')
  })
})
