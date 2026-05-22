import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentRegistry,
  Gateway,
  McpServerRegistry,
  SkillRegistry,
  WorkflowRegistry,
  walkGlob,
} from '../src/index.js'

let projectRoot: string
let stateDir: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-proj-'))
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-gw-state-'))
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

async function writeFile(rel: string, body: string): Promise<void> {
  const path = join(projectRoot, rel)
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, body)
}

describe('walkGlob', () => {
  it('matches simple star and double-star patterns', async () => {
    await writeFile('workflows/a.workflow.ts', '')
    await writeFile('workflows/sub/b.workflow.ts', '')
    await writeFile('workflows/skip.txt', '')
    const matches = await walkGlob(projectRoot, 'workflows/**/*.workflow.{mts,ts}')
    expect(matches).toEqual([
      join(projectRoot, 'workflows/a.workflow.ts'),
      join(projectRoot, 'workflows/sub/b.workflow.ts'),
    ])
  })

  it('skips node_modules and dist', async () => {
    await writeFile('node_modules/foo/x.workflow.ts', '')
    await writeFile('dist/x.workflow.ts', '')
    await writeFile('workflows/keep.workflow.ts', '')
    const matches = await walkGlob(projectRoot, '**/*.workflow.ts')
    expect(matches).toEqual([join(projectRoot, 'workflows/keep.workflow.ts')])
  })
})

describe('WorkflowRegistry', () => {
  it('lists discovered workflow files keyed by relative path', async () => {
    await writeFile('workflows/hello.workflow.mts', 'export default {}')
    const reg = new WorkflowRegistry({
      projectRoot,
      glob: 'workflows/**/*.workflow.{mts,ts}',
    })
    await reg.start()
    expect(reg.list()).toEqual([
      {
        id: 'workflows/hello.workflow.mts',
        path: join(projectRoot, 'workflows/hello.workflow.mts'),
      },
    ])
    await reg.close()
  })

  it('emits added/removed events on refresh', async () => {
    await writeFile('workflows/a.workflow.ts', 'v1')
    const reg = new WorkflowRegistry({
      projectRoot,
      glob: 'workflows/**/*.workflow.{mts,ts}',
    })
    await reg.start()
    const events: { added: number; removed: number; modified: number }[] = []
    reg.on('change', (c) =>
      events.push({
        added: c.added.length,
        removed: c.removed.length,
        modified: c.modified.length,
      }),
    )
    await writeFile('workflows/b.workflow.ts', 'v1')
    await reg.refresh()
    await fs.rm(join(projectRoot, 'workflows/a.workflow.ts'))
    await reg.refresh()
    expect(events).toEqual([
      { added: 1, removed: 0, modified: 0 },
      { added: 0, removed: 1, modified: 0 },
    ])
    await reg.close()
  })
})

describe('SkillRegistry', () => {
  it('parses SKILL.md frontmatter and skips malformed files', async () => {
    await writeFile(
      'skills/good/SKILL.md',
      '---\nid: write-tests\ndescription: write tests for the changed code\n---\nprompt body',
    )
    await writeFile('skills/bad/SKILL.md', 'no frontmatter here')
    const reg = new SkillRegistry({ projectRoot, glob: 'skills/**/SKILL.md' })
    await reg.start()
    const list = reg.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('write-tests')
    expect(list[0]?.description).toBe('write tests for the changed code')
    expect(reg.getErrors().size).toBe(1)
    await reg.close()
  })
})

describe('AgentRegistry / McpServerRegistry', () => {
  it('exposes config-driven entries and refreshes on setAgents', async () => {
    const reg = new AgentRegistry([
      { id: 'opencode-1', runtime: 'opencode', lifecycle: 'resident' },
    ])
    await reg.refresh()
    expect(reg.list().map((a) => a.id)).toEqual(['opencode-1'])

    let changes = 0
    reg.on('change', () => changes++)
    reg.setAgents([
      { id: 'opencode-1', runtime: 'opencode', lifecycle: 'resident' },
      { id: 'claude-code', runtime: 'claude-code', lifecycle: 'ephemeral' },
    ])
    await reg.refresh()
    expect(reg.list()).toHaveLength(2)
    expect(changes).toBe(1)
    await reg.close()
  })

  it('mcp registry mirrors the same diff semantics', async () => {
    const reg = new McpServerRegistry([{ id: 'fs', transport: 'stdio', command: 'mcp-fs' }])
    await reg.refresh()
    expect(reg.get('fs')?.command).toBe('mcp-fs')
    reg.setServers([])
    const change = await reg.refresh()
    expect(change.removed.map((r) => r.id)).toEqual(['fs'])
    await reg.close()
  })
})

describe('Gateway with registries', () => {
  it('starts with FS-watched registries from config and reloads on demand', async () => {
    await writeFile('workflows/one.workflow.ts', 'export default {}')
    await writeFile('skills/x/SKILL.md', '---\nid: x\ndescription: skill x\n---\nbody')
    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      config: {
        registries: {
          workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' },
          skills: { glob: 'skills/**/SKILL.md' },
          agents: [
            { id: 'a', runtime: 'opencode', lifecycle: 'resident', url: 'http://127.0.0.1:1' },
          ],
          mcpServers: [{ id: 'm', transport: 'stdio', command: 'echo' }],
        },
      },
    })
    await gw.start()
    expect(gw.registries.workflows.list().map((w) => w.id)).toEqual(['workflows/one.workflow.ts'])
    expect(gw.registries.skills.get('x')?.description).toBe('skill x')
    expect(gw.registries.agents.list()).toHaveLength(1)
    expect(gw.registries.mcpServers.list()).toHaveLength(1)

    await writeFile('workflows/two.workflow.ts', 'export default {}')
    await gw.reload()
    expect(gw.registries.workflows.list()).toHaveLength(2)

    await gw.stop()
    expect(() => gw.registries).toThrow(/registries are not available/)
  })
})
