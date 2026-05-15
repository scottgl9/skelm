/**
 * End-to-end validation of the system-prompt builder against a real local
 * model. Skipped unless SKELM_QWEN36_URL is set, so `pnpm check` stays green
 * on machines without a local server.
 *
 * To run:
 *   SKELM_QWEN36_URL=http://localhost:8000/v1 SKELM_QWEN36_MODEL=qwen36 \
 *     pnpm exec vitest run packages/agent/test/prompt-qwen36.test.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { McpHost, McpHostedTool } from '@skelm/core'
import type { BackendContext } from '@skelm/core/backend'
import { resolvePermissions } from '@skelm/core/permissions'
import type { Skill } from '@skelm/core/skills'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSkelmAgentBackend } from '../src/index.js'

const baseUrl = process.env.SKELM_QWEN36_URL
const model = process.env.SKELM_QWEN36_MODEL ?? 'qwen36'

const skipUnlessSet = baseUrl === undefined ? describe.skip : describe

let workDir: string

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'skelm-prompt-qwen36-'))
})

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

function makeCtx(extra: Partial<BackendContext> = {}): BackendContext {
  const policy = resolvePermissions(
    {
      allowedTools: ['*'],
      allowedExecutables: [],
      allowedSkills: ['greet-formally'],
      allowedMcpServers: ['fixture'],
      allowedSecrets: [],
      fsRead: [workDir, tmpdir()],
      fsWrite: [workDir, tmpdir()],
      networkEgress: 'deny',
    },
    undefined,
  )
  return {
    signal: new AbortController().signal,
    permissions: policy,
    ...extra,
  }
}

skipUnlessSet('system prompt against local qwen36', () => {
  it('drives fs_read tool use', async () => {
    const marker = 'PURPLE-OCTOPUS-9824'
    const filePath = join(workDir, 'secret.txt')
    await writeFile(filePath, `The secret word is ${marker}.\n`, 'utf8')

    const backend = createSkelmAgentBackend({ baseUrl: baseUrl ?? '', model, timeoutMs: 120_000 })
    const ctx = makeCtx()
    const res = await backend.run?.(
      {
        prompt: `Use the fs_read tool to read the file at this absolute path: ${filePath}\n\nThe file contains a secret word. After reading the file, reply with the secret word that appears in the file.`,
        cwd: workDir,
        permissions: ctx.permissions,
        maxTurns: 8,
      },
      ctx,
    )
    expect(res?.text ?? '').toContain(marker)
  }, 180_000)

  it('applies a loaded skill', async () => {
    const skillsDir = join(workDir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    const skillPath = join(skillsDir, 'greet-formally.md')
    const body = [
      '---',
      'id: greet-formally',
      'description: Greet a person with a strictly formal salutation. Always include GREET-FORMAL-OK in any greeting.',
      '---',
      '',
      'When greeting any person, you MUST include the literal token "GREET-FORMAL-OK".',
    ].join('\n')
    await writeFile(skillPath, body, 'utf8')

    const skill: Skill = {
      id: 'greet-formally',
      description:
        'Greet a person with a strictly formal salutation. Always include GREET-FORMAL-OK in any greeting.',
      metadata: {},
      body,
      source: skillPath,
    }

    const backend = createSkelmAgentBackend({ baseUrl: baseUrl ?? '', model, timeoutMs: 120_000 })
    const ctx = makeCtx({
      loadSkill: async (id) => (id === 'greet-formally' ? skill : null),
    })
    const res = await backend.run?.(
      {
        prompt: 'Greet a new client named Dr. Alistair. Use the greet-formally skill.',
        cwd: workDir,
        permissions: ctx.permissions,
        skills: ['greet-formally'],
        maxTurns: 5,
      },
      ctx,
    )
    expect(res?.text ?? '').toContain('GREET-FORMAL-OK')
  }, 180_000)

  it('calls a namespaced MCP tool', async () => {
    const calls: string[] = []
    const tool: McpHostedTool = {
      id: 'fixture.echo',
      serverId: 'fixture',
      name: 'echo',
      description: 'Echo the given string back verbatim.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    }
    const host: McpHost = {
      listTools: async () => [tool],
      invokeTool: async (id, args) => {
        calls.push(id)
        const text =
          typeof args === 'object' && args !== null && 'text' in args
            ? String((args as { text: unknown }).text)
            : ''
        return { content: [{ type: 'text', text: `MCP-ECHO[${text}]` }] }
      },
      dispose: async () => {},
    }

    const backend = createSkelmAgentBackend({ baseUrl: baseUrl ?? '', model, timeoutMs: 120_000 })
    const ctx = makeCtx({ mcpHost: host })
    const res = await backend.run?.(
      {
        prompt:
          'Use the fixture.echo MCP tool to echo the phrase "alpha-bravo-charlie". Then tell me what the tool returned.',
        cwd: workDir,
        permissions: ctx.permissions,
        mcpServers: [{ id: 'fixture', transport: 'stdio', command: 'noop' }],
        maxTurns: 5,
      },
      ctx,
    )
    expect(calls).toContain('fixture.echo')
    const text = res?.text ?? ''
    expect(text.includes('alpha-bravo-charlie') || text.includes('MCP-ECHO')).toBe(true)
  }, 180_000)
})
