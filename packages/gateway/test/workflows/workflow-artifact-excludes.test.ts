import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkflowArtifactService, WorkflowRegistrationError } from '../../src/workflows/index.js'

let artifactRoot: string
let sourceRoot: string
const rmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 25 } as const

beforeEach(async () => {
  artifactRoot = await fs.realpath(await mkdtemp(join(tmpdir(), 'skelm-art-')))
  sourceRoot = await fs.realpath(await mkdtemp(join(tmpdir(), 'skelm-art-src-')))
})

afterEach(async () => {
  await rm(artifactRoot, rmOptions)
  await rm(sourceRoot, rmOptions)
})

function service(maxBytes = 5_000_000): WorkflowArtifactService {
  return new WorkflowArtifactService({ artifactRoot, maxBytes })
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}

async function writeBig(path: string, bytes: number): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true }).catch(() => {})
  await fs.writeFile(path, Buffer.alloc(bytes, 0x61))
}

describe('WorkflowArtifactService materialization excludes', () => {
  it('materializes a tree whose large output dir is gitignored (the 413 regression)', async () => {
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    await fs.writeFile(join(sourceRoot, '.gitignore'), 'reports/\n')
    // 6 MB of ignored build output — would blow the 5 MB cap if copied.
    await fs.mkdir(join(sourceRoot, 'reports'))
    await writeBig(join(sourceRoot, 'reports', 'big.json'), 6_000_000)

    const artifact = await service(5_000_000).materializeTree({
      id: 'gitignored-big',
      sourceRoot,
      entryPath: entry,
    })

    expect(await exists(join(artifact.artifactDir, 'reports'))).toBe(false)
    expect((await fs.stat(artifact.entryPath)).isFile()).toBe(true)
  })

  it('honors a .gitignore entry while still copying non-ignored source', async () => {
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    await fs.writeFile(join(sourceRoot, '.gitignore'), 'secrets.txt\nlogs/\n')
    await fs.writeFile(join(sourceRoot, 'secrets.txt'), 'do not copy')
    await fs.mkdir(join(sourceRoot, 'logs'))
    await fs.writeFile(join(sourceRoot, 'logs', 'run.log'), 'noise')
    await fs.mkdir(join(sourceRoot, 'src'))
    await fs.writeFile(join(sourceRoot, 'src', 'keep.ts'), 'export const keep = 1')

    const artifact = await service().materializeTree({
      id: 'gitignore-honored',
      sourceRoot,
      entryPath: entry,
    })

    expect(await exists(join(artifact.artifactDir, 'secrets.txt'))).toBe(false)
    expect(await exists(join(artifact.artifactDir, 'logs'))).toBe(false)
    expect(await fs.readFile(join(artifact.artifactDir, 'src', 'keep.ts'), 'utf8')).toBe(
      'export const keep = 1',
    )
  })

  it('honors an anchored .gitignore pattern only at the root', async () => {
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    await fs.writeFile(join(sourceRoot, '.gitignore'), '/generated\n')
    await fs.mkdir(join(sourceRoot, 'generated'))
    await fs.writeFile(join(sourceRoot, 'generated', 'root-out.txt'), 'root')
    await fs.mkdir(join(sourceRoot, 'pkg', 'generated'), { recursive: true })
    await fs.writeFile(join(sourceRoot, 'pkg', 'generated', 'nested.txt'), 'nested')

    const artifact = await service().materializeTree({
      id: 'anchored',
      sourceRoot,
      entryPath: entry,
    })

    expect(await exists(join(artifact.artifactDir, 'generated'))).toBe(false)
    // Anchored "/generated" must NOT match the nested pkg/generated.
    expect(
      await fs.readFile(join(artifact.artifactDir, 'pkg', 'generated', 'nested.txt'), 'utf8'),
    ).toBe('nested')
  })

  it('a directory-only rule (config/) ignores the directory but NOT a sibling file named config', async () => {
    // Git semantics: a trailing-slash rule matches the directory and its
    // contents, not a plain file of the same name. (`config` is not in the
    // hard denylist, so this isolates the dirOnly behavior.)
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    await fs.writeFile(join(sourceRoot, '.gitignore'), 'config/\n')
    await fs.mkdir(join(sourceRoot, 'config'))
    await fs.writeFile(join(sourceRoot, 'config', 'secret.txt'), 'ignored')
    await fs.mkdir(join(sourceRoot, 'pkg'))
    // A plain FILE named `config` (no trailing slash) must survive.
    await fs.writeFile(join(sourceRoot, 'pkg', 'config'), 'keep me')

    const artifact = await service().materializeTree({
      id: 'dironly',
      sourceRoot,
      entryPath: entry,
    })

    expect(await exists(join(artifact.artifactDir, 'config'))).toBe(false)
    expect(await fs.readFile(join(artifact.artifactDir, 'pkg', 'config'), 'utf8')).toBe('keep me')
  })

  it('descends into an ignored dir to honor a negated re-include (dist/ + !dist/keep.js)', async () => {
    // Git semantics: `dist/` ignores the tree, but `!dist/keep.js` re-includes
    // that one descendant. The walker must descend into dist/ rather than
    // pruning it, keep keep.js, and still drop the rest.
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    await fs.writeFile(join(sourceRoot, '.gitignore'), 'dist/\n!dist/keep.js\n')
    await fs.mkdir(join(sourceRoot, 'dist'))
    await fs.writeFile(join(sourceRoot, 'dist', 'keep.js'), 'export default 1')
    await fs.writeFile(join(sourceRoot, 'dist', 'drop.js'), 'export default 2')
    await fs.mkdir(join(sourceRoot, 'dist', 'sub'))
    await fs.writeFile(join(sourceRoot, 'dist', 'sub', 'also-drop.js'), 'x')

    const artifact = await service().materializeTree({
      id: 'negated-reinclude',
      sourceRoot,
      entryPath: entry,
    })

    // The re-included file survives.
    expect(await fs.readFile(join(artifact.artifactDir, 'dist', 'keep.js'), 'utf8')).toBe(
      'export default 1',
    )
    // The rest of the ignored tree is still dropped.
    expect(await exists(join(artifact.artifactDir, 'dist', 'drop.js'))).toBe(false)
    expect(await exists(join(artifact.artifactDir, 'dist', 'sub'))).toBe(false)
  })

  it('still prunes an ignored dir entirely when no negation re-includes a descendant', async () => {
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    // A negation elsewhere must not force a needless descend into out/.
    await fs.writeFile(join(sourceRoot, '.gitignore'), 'out/\n!keep-me.txt\n')
    await fs.mkdir(join(sourceRoot, 'out'))
    await fs.writeFile(join(sourceRoot, 'out', 'big.bin'), 'x'.repeat(1000))

    const artifact = await service().materializeTree({
      id: 'pruned-no-reinclude',
      sourceRoot,
      entryPath: entry,
    })

    // `!keep-me.txt` is a basename re-include that could match anywhere, so the
    // walker descends; out/ has no re-included file, so it ends up empty/absent
    // of content. The point: out/big.bin is NOT copied.
    expect(await exists(join(artifact.artifactDir, 'out', 'big.bin'))).toBe(false)
  })

  it('excludes structural/cache dirs via the hard denylist even without .gitignore', async () => {
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    for (const dir of ['.git', '.skelm', 'coverage', '.codegraph', 'logs']) {
      await fs.mkdir(join(sourceRoot, dir))
      await fs.writeFile(join(sourceRoot, dir, 'f.txt'), 'x')
    }

    const artifact = await service().materializeTree({
      id: 'denylist',
      sourceRoot,
      entryPath: entry,
    })

    for (const dir of ['.git', '.skelm', 'coverage', '.codegraph', 'logs']) {
      expect(await exists(join(artifact.artifactDir, dir))).toBe(false)
    }
  })

  it('copies a non-gitignored dist/ so a workflow can import its compiled output', async () => {
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    await fs.mkdir(join(sourceRoot, 'dist'))
    await fs.writeFile(join(sourceRoot, 'dist', 'step.js'), 'export default 1')

    const artifact = await service().materializeTree({
      id: 'dist-kept',
      sourceRoot,
      entryPath: entry,
    })

    expect(await fs.readFile(join(artifact.artifactDir, 'dist', 'step.js'), 'utf8')).toBe(
      'export default 1',
    )
  })

  it('still 413s on a genuinely oversized SOURCE tree (cap intact)', async () => {
    const entry = join(sourceRoot, 'a.workflow.ts')
    await fs.writeFile(entry, 'export default {}')
    // Not ignored, not excluded — genuine source that exceeds the cap.
    await fs.mkdir(join(sourceRoot, 'src'))
    await writeBig(join(sourceRoot, 'src', 'huge.ts'), 6_000_000)

    await expect(
      service(5_000_000).materializeTree({ id: 'oversized', sourceRoot, entryPath: entry }),
    ).rejects.toMatchObject({ statusCode: 413 })
  })
})
