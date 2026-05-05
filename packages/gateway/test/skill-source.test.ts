import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillRegistry, createSkillSource } from '../src/index.js'

let projectRoot: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-skill-src-'))
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

async function write(rel: string, body: string): Promise<void> {
  const path = join(projectRoot, rel)
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, body)
}

describe('createSkillSource', () => {
  it('returns the registered skill when the registry knows the id', async () => {
    await write('skills/registered/SKILL.md', '---\nid: registered\n---\nfrom registry')
    const registry = new SkillRegistry({ projectRoot, glob: 'skills/**/SKILL.md' })
    await registry.start()
    const source = createSkillSource({ registry })
    const hit = await source('registered')
    expect(hit?.id).toBe('registered')
    expect(hit?.body).toBe('from registry')
    await registry.close()
  })

  it('falls back to <workflowDir>/skills/<id>/SKILL.md when not registered', async () => {
    await write('flows/foo.workflow.ts', 'export default {}')
    await write('flows/skills/local-only/SKILL.md', '---\nid: local-only\n---\nco-located')
    const registry = new SkillRegistry({ projectRoot, glob: 'skills/**/SKILL.md' })
    await registry.start()
    const source = createSkillSource({
      registry,
      workflowPath: join(projectRoot, 'flows/foo.workflow.ts'),
    })
    const hit = await source('local-only')
    expect(hit?.id).toBe('local-only')
    expect(hit?.body).toBe('co-located')
    await registry.close()
  })

  it('falls back to skillsDir when set and the registry/workflow miss', async () => {
    await write('configured/elsewhere/SKILL.md', '---\nid: elsewhere\n---\nfrom skillsDir')
    const registry = new SkillRegistry({ projectRoot, glob: 'never/**/SKILL.md' })
    await registry.start()
    const source = createSkillSource({
      registry,
      skillsDir: join(projectRoot, 'configured'),
    })
    const hit = await source('elsewhere')
    expect(hit?.id).toBe('elsewhere')
    await registry.close()
  })

  it('returns null for unknown ids', async () => {
    const registry = new SkillRegistry({ projectRoot, glob: 'never/**/SKILL.md' })
    await registry.start()
    const source = createSkillSource({
      registry,
      workflowPath: join(projectRoot, 'flows/foo.workflow.ts'),
    })
    expect(await source('does-not-exist')).toBeNull()
    await registry.close()
  })

  it('returns null (not throws) when a fallback SKILL.md is malformed', async () => {
    await write('flows/foo.workflow.ts', 'export default {}')
    await write('flows/skills/broken/SKILL.md', 'no frontmatter')
    const registry = new SkillRegistry({ projectRoot, glob: 'never/**/SKILL.md' })
    await registry.start()
    const source = createSkillSource({
      registry,
      workflowPath: join(projectRoot, 'flows/foo.workflow.ts'),
    })
    expect(await source('broken')).toBeNull()
    await registry.close()
  })

  it('registry hit shadows workflow-relative fallback', async () => {
    await write(
      'skills/shared/SKILL.md',
      '---\nid: shared\ndescription: from-registry\n---\nregistered',
    )
    await write('flows/foo.workflow.ts', 'export default {}')
    await write(
      'flows/skills/shared/SKILL.md',
      '---\nid: shared\ndescription: from-workflow-dir\n---\nfallback',
    )
    const registry = new SkillRegistry({ projectRoot, glob: 'skills/**/SKILL.md' })
    await registry.start()
    const source = createSkillSource({
      registry,
      workflowPath: join(projectRoot, 'flows/foo.workflow.ts'),
    })
    const hit = await source('shared')
    expect(hit?.description).toBe('from-registry')
    await registry.close()
  })
})
