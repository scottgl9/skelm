import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkflowArtifactService, WorkflowRegistrationError } from '../../src/workflows/index.js'

let artifactRoot: string
let sourceRoot: string
let outside: string
const rmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 25 } as const

beforeEach(async () => {
  artifactRoot = await fs.realpath(await mkdtemp(join(tmpdir(), 'skelm-art-')))
  sourceRoot = await fs.realpath(await mkdtemp(join(tmpdir(), 'skelm-art-src-')))
  outside = await fs.realpath(await mkdtemp(join(tmpdir(), 'skelm-art-out-')))
})

afterEach(async () => {
  await rm(artifactRoot, rmOptions)
  await rm(sourceRoot, rmOptions)
  await rm(outside, rmOptions)
})

function service(): WorkflowArtifactService {
  return new WorkflowArtifactService({ artifactRoot, maxBytes: 10_000_000 })
}

describe('WorkflowArtifactService symlink handling', () => {
  it('dereferences an intra-tree symlink into a regular file (CLAUDE.md -> AGENTS.md)', async () => {
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    await fs.writeFile(join(sourceRoot, 'AGENTS.md'), 'guidance content')
    await fs.symlink('./AGENTS.md', join(sourceRoot, 'CLAUDE.md'))

    const artifact = await service().materializeTree({
      id: 'intra-link',
      sourceRoot,
      entryPath: entry,
    })

    const copied = join(artifact.artifactDir, 'CLAUDE.md')
    const stat = await fs.lstat(copied)
    expect(stat.isSymbolicLink()).toBe(false)
    expect(stat.isFile()).toBe(true)
    expect(await fs.readFile(copied, 'utf8')).toBe('guidance content')
  })

  it('dereferences an intra-tree directory symlink', async () => {
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    await fs.mkdir(join(sourceRoot, 'real'))
    await fs.writeFile(join(sourceRoot, 'real', 'x.txt'), 'hi')
    await fs.symlink(join(sourceRoot, 'real'), join(sourceRoot, 'link'))

    const artifact = await service().materializeTree({
      id: 'dir-link',
      sourceRoot,
      entryPath: entry,
    })

    expect(await fs.readFile(join(artifact.artifactDir, 'link', 'x.txt'), 'utf8')).toBe('hi')
  })

  it('rejects a symlink whose target is outside the source root (absolute escape)', async () => {
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    const secretValue = 'top-secret-external-content'
    const secret = join(outside, 'secret.txt')
    await fs.writeFile(secret, secretValue)
    await fs.symlink(secret, join(sourceRoot, 'evil'))

    await expect(
      service().materializeTree({ id: 'escape-abs', sourceRoot, entryPath: entry }),
    ).rejects.toMatchObject({ statusCode: 400 })

    // No external content was smuggled into the gateway-owned artifact tree.
    const published = join(artifactRoot, encodeURIComponent('escape-abs'))
    const leaked = await containsContent(published, secretValue)
    expect(leaked).toBe(false)
  })

  it('rejects a symlink that escapes via .. relative traversal', async () => {
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    await fs.writeFile(join(outside, 'secret.txt'), 'external')
    await fs.symlink('../../', join(sourceRoot, 'climb'))

    await expect(
      service().materializeTree({ id: 'escape-rel', sourceRoot, entryPath: entry }),
    ).rejects.toBeInstanceOf(WorkflowRegistrationError)
  })

  it('rejects an unresolvable (dangling) symlink', async () => {
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    await fs.symlink('./does-not-exist', join(sourceRoot, 'dangling'))

    await expect(
      service().materializeTree({ id: 'dangling', sourceRoot, entryPath: entry }),
    ).rejects.toBeInstanceOf(WorkflowRegistrationError)
  })

  it('terminates on a symlink cycle instead of looping forever', async () => {
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    // In-root directory cycle: dir/back -> dir. The visited-set guard breaks
    // the recursion; a regression here would hang until the test timeout.
    await fs.mkdir(join(sourceRoot, 'dir'))
    await fs.symlink(join(sourceRoot, 'dir'), join(sourceRoot, 'dir', 'back'))

    const artifact = await service().materializeTree({
      id: 'cycle',
      sourceRoot,
      entryPath: entry,
    })
    expect((await fs.stat(artifact.entryPath)).isFile()).toBe(true)
  })
})

async function containsContent(dir: string, needle: string): Promise<boolean> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return false
  }
  for (const name of names) {
    const p = join(dir, name)
    const stat = await fs.lstat(p)
    if (stat.isDirectory()) {
      if (await containsContent(p, needle)) return true
    } else if (stat.isFile()) {
      if ((await fs.readFile(p, 'utf8')).includes(needle)) return true
    }
  }
  return false
}
