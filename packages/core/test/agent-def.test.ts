import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentDefinitionError, loadAgentDefinition } from '../src/agent-def.js'

let projectRoot: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-agentdef-'))
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

async function write(rel: string, body: string): Promise<void> {
  const path = join(projectRoot, rel)
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, body)
}

describe('loadAgentDefinition', () => {
  it('loads AGENTS.md (instructions) and SOUL.md (soul) from a workflow-relative spec', async () => {
    await write('flows/foo.workflow.ts', 'export default {}')
    await write('flows/agents/jira-agent/AGENTS.md', 'You are the jira agent.')
    await write('flows/agents/jira-agent/SOUL.md', 'persona text')
    const def = await loadAgentDefinition('./agents/jira-agent', {
      workflowPath: join(projectRoot, 'flows/foo.workflow.ts'),
    })
    expect(def.id).toBe('jira-agent')
    expect(def.instructions).toBe('You are the jira agent.')
    expect(def.soul).toBe('persona text')
    expect(def.source).toBe(join(projectRoot, 'flows/agents/jira-agent'))
  })

  it('treats SOUL.md as optional', async () => {
    await write('flows/foo.workflow.ts', 'export default {}')
    await write('flows/agents/quiet/AGENTS.md', 'instructions only')
    const def = await loadAgentDefinition('./agents/quiet', {
      workflowPath: join(projectRoot, 'flows/foo.workflow.ts'),
    })
    expect(def.soul).toBeUndefined()
    expect(def.instructions).toBe('instructions only')
  })

  it('throws AgentDefinitionError when AGENTS.md is missing', async () => {
    await write('flows/foo.workflow.ts', 'export default {}')
    await fs.mkdir(join(projectRoot, 'flows/agents/empty'), { recursive: true })
    await expect(
      loadAgentDefinition('./agents/empty', {
        workflowPath: join(projectRoot, 'flows/foo.workflow.ts'),
      }),
    ).rejects.toBeInstanceOf(AgentDefinitionError)
  })

  it('rejects path traversal that escapes agentDefRoot', async () => {
    await write('flows/foo.workflow.ts', 'export default {}')
    await write('outside/AGENTS.md', 'should not be reachable')
    await expect(
      loadAgentDefinition('../outside', {
        workflowPath: join(projectRoot, 'flows/foo.workflow.ts'),
      }),
    ).rejects.toBeInstanceOf(AgentDefinitionError)
  })

  it('honors agentDefRoot override (used in tests with no workflow file)', async () => {
    await write('canonical/agents/x/AGENTS.md', 'rooted')
    const def = await loadAgentDefinition('agents/x', {
      agentDefRoot: join(projectRoot, 'canonical'),
    })
    expect(def.instructions).toBe('rooted')
  })

  it('throws when the spec is relative but no anchor was provided', async () => {
    await expect(loadAgentDefinition('./agents/x', {})).rejects.toBeInstanceOf(AgentDefinitionError)
  })

  it('rejects an empty spec', async () => {
    await expect(loadAgentDefinition('', {})).rejects.toBeInstanceOf(AgentDefinitionError)
  })
})
