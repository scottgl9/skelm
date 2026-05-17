import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { walkGlob } from '../src/registries/glob.js'

describe('walkGlob — bounded by static prefix', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skelm-glob-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('matches files under the glob-prefix subtree', async () => {
    await mkdir(join(root, 'workflows'), { recursive: true })
    await writeFile(join(root, 'workflows', 'a.workflow.ts'), '')
    await writeFile(join(root, 'workflows', 'b.workflow.ts'), '')
    const got = await walkGlob(root, 'workflows/**/*.workflow.ts')
    expect(got).toHaveLength(2)
  })

  it('does NOT descend siblings of the glob prefix', async () => {
    // workflows/ exists with one match
    await mkdir(join(root, 'workflows'), { recursive: true })
    await writeFile(join(root, 'workflows', 'a.workflow.ts'), '')
    // A sibling subtree we'd never want to scan ($HOME under systemd-user
    // would expose this — Downloads, .cache, mounted drives, etc.).
    await mkdir(join(root, 'huge-irrelevant-tree', 'deep', 'nested'), { recursive: true })
    await writeFile(join(root, 'huge-irrelevant-tree', 'deep', 'nested', 'bait.workflow.ts'), '')

    const got = await walkGlob(root, 'workflows/**/*.workflow.ts')
    expect(got).toHaveLength(1)
    expect(got[0]).toMatch(/workflows\/a\.workflow\.ts$/)
  })

  it('returns empty when the prefix directory does not exist (no scan)', async () => {
    // The prefix dir is missing entirely — without prefix bounding, an old
    // walker would still recurse from rootDir.
    await mkdir(join(root, 'unrelated', 'deep'), { recursive: true })
    await writeFile(join(root, 'unrelated', 'deep', 'x.workflow.ts'), '')

    const got = await walkGlob(root, 'workflows/**/*.workflow.ts')
    expect(got).toEqual([])
  })

  it('still works for top-level globs (no static prefix)', async () => {
    await writeFile(join(root, 'a.ts'), '')
    await mkdir(join(root, 'sub'), { recursive: true })
    await writeFile(join(root, 'sub', 'b.ts'), '')

    const got = await walkGlob(root, '**/*.ts')
    expect(got.length).toBe(2)
  })
})
