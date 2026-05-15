#!/usr/bin/env tsx
/**
 * End-to-end validation of the skelm system-prompt builder against a local
 * qwen36 model (or any OpenAI-compatible endpoint pointed at SKELM_QWEN36_URL).
 *
 * Runs three scenarios through @skelm/agent's run() and reports pass/fail:
 *
 *   1. Tools   — agent must call fs_read to retrieve a marker from a temp file.
 *   2. Skills  — agent must apply a fixture skill's instructions (load on demand).
 *   3. MCP     — agent must call a stubbed namespaced MCP tool.
 *
 * Usage:
 *   pnpm tsx scripts/validate-prompt-qwen36.ts
 *   SKELM_QWEN36_URL=http://localhost:11434/v1 pnpm tsx scripts/validate-prompt-qwen36.ts
 *   SKELM_QWEN36_MODEL=qwen3-coder-30b-instruct pnpm tsx scripts/validate-prompt-qwen36.ts
 *
 * Default endpoint: http://localhost:8080/v1 (llama.cpp server).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSkelmAgentBackend } from '../packages/agent/src/index.ts'
import type { BackendContext } from '../packages/core/src/backend.ts'
import type { McpHost, McpHostedTool } from '../packages/core/src/mcp/host.ts'
import { resolvePermissions } from '../packages/core/src/permissions.ts'
import type { Skill } from '../packages/core/src/skills.ts'

const DEFAULT_URL = 'http://localhost:8080/v1'
const baseUrl = process.env.SKELM_QWEN36_URL ?? DEFAULT_URL
const model = process.env.SKELM_QWEN36_MODEL ?? 'qwen3'

interface ScenarioResult {
  name: string
  passed: boolean
  detail: string
  text?: string
}

async function preflight(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok && res.status !== 404) {
      console.error(`Preflight failed: ${baseUrl}/models returned ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    console.error(`Cannot reach ${baseUrl} — ${(err as Error).message}`)
    console.error('Set SKELM_QWEN36_URL or start your local model server.')
    return false
  }
}

function makeBackend() {
  return createSkelmAgentBackend({ baseUrl, model, timeoutMs: 120_000 })
}

function makeCtx(opts: {
  cwd: string
  loadSkill?: (id: string) => Promise<Skill | null>
  mcpHost?: McpHost
}): BackendContext {
  const policy = resolvePermissions(
    {
      allowedTools: ['*'],
      allowedExecutables: [],
      allowedSkills: ['greet-formally'],
      allowedMcpServers: ['fixture'],
      allowedSecrets: [],
      fsRead: [opts.cwd, tmpdir()],
      fsWrite: [opts.cwd, tmpdir()],
      networkEgress: 'deny',
    },
    undefined,
  )
  return {
    signal: new AbortController().signal,
    permissions: policy,
    ...(opts.loadSkill && { loadSkill: opts.loadSkill }),
    ...(opts.mcpHost && { mcpHost: opts.mcpHost }),
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: tool use
// ---------------------------------------------------------------------------

async function scenarioTools(work: string): Promise<ScenarioResult> {
  const marker = 'PURPLE-OCTOPUS-9824'
  const filePath = join(work, 'fixture.txt')
  await writeFile(filePath, `The fixture marker is ${marker}.\n`, 'utf8')

  const backend = makeBackend()
  const ctx = makeCtx({ cwd: work })
  const res = await backend.run?.(
    {
      prompt: `Use the fs_read tool to read the file at this absolute path: ${filePath}\n\nThe file contains a fixture marker. After reading the file, reply with the marker value that appears in the file.`,
      cwd: work,
      permissions: ctx.permissions,
      maxTurns: 8,
    },
    ctx,
  )
  const text = res?.text ?? ''
  const stop = res?.stopReason ?? '?'
  return {
    name: 'tools (fs_read)',
    passed: text.includes(marker),
    detail: text.includes(marker)
      ? 'model retrieved the marker via fs_read'
      : `expected marker "${marker}" in reply; stop=${stop}; text=${text.slice(0, 200) || '<empty>'}`,
    text,
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: skills
// ---------------------------------------------------------------------------

async function scenarioSkills(work: string): Promise<ScenarioResult> {
  const skillsDir = join(work, 'skills')
  await mkdir(skillsDir, { recursive: true })
  const skillPath = join(skillsDir, 'greet-formally.md')
  const skillBody = [
    '---',
    'id: greet-formally',
    'description: Greet a person with a strictly formal salutation. Always include the salutation token GREET-FORMAL-OK in any greeting.',
    '---',
    '',
    '# greet-formally',
    '',
    'When greeting any person, you MUST:',
    '1. Begin with "Esteemed".',
    '2. Always include the literal token "GREET-FORMAL-OK" somewhere in the greeting.',
    '3. Avoid casual language like "hi" or "hey".',
  ].join('\n')
  await writeFile(skillPath, skillBody, 'utf8')

  const skill: Skill = {
    id: 'greet-formally',
    description:
      'Greet a person with a strictly formal salutation. Always include the salutation token GREET-FORMAL-OK in any greeting.',
    metadata: {},
    body: skillBody,
    source: skillPath,
  }

  const backend = makeBackend()
  const ctx = makeCtx({
    cwd: work,
    loadSkill: async (id) => (id === 'greet-formally' ? skill : null),
  })

  const res = await backend.run?.(
    {
      prompt: 'Greet a new client named Dr. Alistair. Use the greet-formally skill.',
      cwd: work,
      permissions: ctx.permissions,
      skills: ['greet-formally'],
      maxTurns: 5,
    },
    ctx,
  )
  const text = res?.text ?? ''
  const passed = text.includes('GREET-FORMAL-OK')
  return {
    name: 'skills (greet-formally)',
    passed,
    detail: passed
      ? 'model applied the skill token'
      : `expected GREET-FORMAL-OK in reply; got: ${text.slice(0, 200)}`,
    text,
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: MCP (stubbed host)
// ---------------------------------------------------------------------------

function makeStubMcpHost(): { host: McpHost; calls: string[] } {
  const calls: string[] = []
  const tool: McpHostedTool = {
    id: 'fixture.echo',
    serverId: 'fixture',
    name: 'echo',
    description: 'Echo the given string back verbatim. Use this to repeat input.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  }
  const host: McpHost = {
    listTools: async () => [tool],
    invokeTool: async (toolId, args) => {
      calls.push(toolId)
      const text =
        typeof args === 'object' && args !== null && 'text' in args
          ? String((args as { text: unknown }).text)
          : ''
      return { content: [{ type: 'text', text: `MCP-ECHO[${text}]` }] }
    },
    dispose: async () => {},
  }
  return { host, calls }
}

async function scenarioMcp(work: string): Promise<ScenarioResult> {
  const { host, calls } = makeStubMcpHost()
  const backend = makeBackend()
  const ctx = makeCtx({ cwd: work, mcpHost: host })

  const res = await backend.run?.(
    {
      prompt:
        'Use the fixture.echo MCP tool to echo the phrase "alpha-bravo-charlie". Then tell me what the tool returned.',
      cwd: work,
      permissions: ctx.permissions,
      mcpServers: [{ id: 'fixture', transport: 'stdio', command: 'noop' }],
      maxTurns: 5,
    },
    ctx,
  )
  const text = res?.text ?? ''
  const called = calls.includes('fixture.echo')
  const echoed = text.includes('alpha-bravo-charlie') || text.includes('MCP-ECHO')
  const passed = called && echoed
  return {
    name: 'mcp (fixture.echo)',
    passed,
    detail: passed
      ? `model called fixture.echo (${calls.length}x) and surfaced the result`
      : `called=${called} echoed=${echoed}; calls=[${calls.join(',')}]; text=${text.slice(0, 200)}`,
    text,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`skelm system-prompt validation against ${baseUrl} (model=${model})\n`)
  const ok = await preflight()
  if (!ok) process.exit(2)

  const work = await mkdtemp(join(tmpdir(), 'skelm-prompt-validate-'))
  const results: ScenarioResult[] = []
  try {
    for (const scenario of [scenarioTools, scenarioSkills, scenarioMcp]) {
      try {
        results.push(await scenario(work))
      } catch (err) {
        results.push({
          name: scenario.name,
          passed: false,
          detail: `threw: ${(err as Error).message}`,
        })
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }

  console.log('\n=== Results ===')
  for (const r of results) {
    const mark = r.passed ? 'PASS' : 'FAIL'
    console.log(`[${mark}] ${r.name} — ${r.detail}`)
  }
  const allPassed = results.every((r) => r.passed)
  process.exit(allPassed ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
