import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyRunTarget } from '../src/classify-run-target.js'

// Fixtures export plain objects (no @skelm/core import) so they load from the
// OS tmp dir under vitest's loader. classifyRunTarget only reads the config
// shape and the entrypoint's `kind` discriminant, so plain objects suffice.

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skelm-classify-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('classifyRunTarget', () => {
  it('treats a file argument as a one-shot run', async () => {
    const file = join(dir, 'x.workflow.mts')
    await writeFile(file, 'export default {}', 'utf8')
    const target = await classifyRunTarget(file)
    expect(target).toEqual({ mode: 'one-shot', file })
  })

  it('treats a non-existent path as a one-shot run (gateway reports not-found)', async () => {
    const file = join(dir, 'nope.workflow.mts')
    const target = await classifyRunTarget(file)
    expect(target).toEqual({ mode: 'one-shot', file })
  })

  it('activates a directory whose config declares triggerSources', async () => {
    await writeFile(
      join(dir, 'skelm.config.mts'),
      'export default { triggerSources: [{ id: "x", driver: { start() {}, stop() {} } }] }',
      'utf8',
    )
    await writeFile(join(dir, 'a.workflow.mts'), 'export default {}', 'utf8')
    const target = await classifyRunTarget(dir)
    expect(target).toEqual({ mode: 'activate', dir })
  })

  it('activates a directory whose entrypoint is a persistent workflow object (no triggerSources)', async () => {
    await writeFile(join(dir, 'skelm.config.mts'), 'export default {}', 'utf8')
    await writeFile(
      join(dir, 'index.workflow.mts'),
      'export default { kind: "persistent-workflow", id: "p", agent: {} }',
      'utf8',
    )
    const target = await classifyRunTarget(dir)
    expect(target).toEqual({ mode: 'activate', dir })
  })

  it('activates a directory with a persistentWorkflow() default export without executing it', async () => {
    await writeFile(join(dir, 'skelm.config.mts'), 'export default {}', 'utf8')
    const marker = join(dir, 'side-effect.txt')
    await writeFile(
      join(dir, 'index.workflow.mts'),
      `import { writeFileSync } from 'node:fs'
import { persistentWorkflow } from '@skelm/core'
writeFileSync(${JSON.stringify(marker)}, 'ran')
export default persistentWorkflow({
  id: 'bot',
  sessionKey: () => 's',
  agent: { id: 'agent', backend: 'native', prompt: 'hi' },
})`,
      'utf8',
    )
    const target = await classifyRunTarget(dir)
    expect(target).toEqual({ mode: 'activate', dir })
    await expect(access(marker)).rejects.toThrow()
  })

  it('activates a directory with a named persistentWorkflow() default export', async () => {
    await writeFile(join(dir, 'skelm.config.mts'), 'export default {}', 'utf8')
    await writeFile(
      join(dir, 'index.workflow.mts'),
      `import { persistentWorkflow } from '@skelm/core'
const bot = persistentWorkflow({ id: 'bot', sessionKey: () => 's', agent: {} })
export default bot`,
      'utf8',
    )
    const target = await classifyRunTarget(dir)
    expect(target).toEqual({ mode: 'activate', dir })
  })

  it('one-shots a directory whose entrypoint is a plain pipeline', async () => {
    await writeFile(join(dir, 'skelm.config.mts'), 'export default {}', 'utf8')
    const entry = join(dir, 'index.workflow.mts')
    await writeFile(entry, 'export default { kind: "pipeline", id: "q" }', 'utf8')
    const target = await classifyRunTarget(dir)
    expect(target).toEqual({ mode: 'one-shot', file: entry })
  })

  it('routes a directory with a tui-transport trigger source to tui mode', async () => {
    await writeFile(
      join(dir, 'skelm.config.mts'),
      'export default { triggerSources: [{ id: "tui", driver: { transport: "tui", start() {}, stop() {} } }] }',
      'utf8',
    )
    await writeFile(join(dir, 'chat.workflow.mts'), 'export default {}', 'utf8')
    const target = await classifyRunTarget(dir)
    expect(target).toEqual({ mode: 'tui', dir, sourceId: 'tui' })
  })

  it('one-shots a plain directory with a single workflow file and no config', async () => {
    const entry = join(dir, 'only.workflow.mts')
    await writeFile(entry, 'export default {}', 'utf8')
    const target = await classifyRunTarget(dir)
    expect(target).toEqual({ mode: 'one-shot', file: entry })
  })
})
