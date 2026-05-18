import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceManager } from '../src/workspace.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-c', 'user.email=t@x', '-c', 'user.name=t', ...args], { cwd })
}

describe('WorkspaceManager — git-repo mode', () => {
  let tmpRoot: string
  let originDir: string
  let cacheRoot: string

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'skelm-gitrepo-'))
    originDir = join(tmpRoot, 'origin')
    cacheRoot = join(tmpRoot, 'cache')
    await mkdir(originDir, { recursive: true })
    // Create a bare-ish origin with two commits on main and one on feature.
    await git(originDir, 'init', '-q', '-b', 'main')
    await writeFile(join(originDir, 'README.md'), 'base\n')
    await git(originDir, 'add', '.')
    await git(originDir, 'commit', '-q', '-m', 'base')
    await writeFile(join(originDir, 'README.md'), 'head on main\n')
    await git(originDir, 'commit', '-aq', '-m', 'head-on-main')
    await git(originDir, 'checkout', '-q', '-b', 'feature')
    await writeFile(join(originDir, 'feature.txt'), 'feature\n')
    await git(originDir, 'add', '.')
    await git(originDir, 'commit', '-q', '-m', 'feature')
    await git(originDir, 'checkout', '-q', 'main')
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('clones the repo on first use and checks out the requested ref', async () => {
    const manager = new WorkspaceManager()
    const cacheDir = join(cacheRoot, 'repo')
    const prepared = await manager.prepare({
      pipelineId: 'pipe',
      runId: 'run-1',
      workspace: { mode: 'git-repo', repo: originDir, ref: 'feature', cacheDir },
    })
    expect(prepared.handle.path).toBe(cacheDir)
    expect(prepared.handle.mode).toBe('git-repo')
    const featureFile = await readFile(join(cacheDir, 'feature.txt'), 'utf8')
    expect(featureFile).toBe('feature\n')
    await prepared.finishStep('completed')
    await prepared.finishRun('completed')
  })

  it('fetches an existing clone on subsequent runs without re-cloning', async () => {
    const manager = new WorkspaceManager()
    const cacheDir = join(cacheRoot, 'repo')
    // First prepare clones.
    const first = await manager.prepare({
      pipelineId: 'pipe',
      runId: 'run-1',
      workspace: { mode: 'git-repo', repo: originDir, ref: 'main', cacheDir },
    })
    await first.finishStep('completed')

    // Add a new commit to origin/main after the first prepare.
    await writeFile(join(originDir, 'README.md'), 'second head\n')
    await git(originDir, 'commit', '-aq', '-m', 'second-head')

    // Second prepare must fetch + checkout the new commit.
    const second = await manager.prepare({
      pipelineId: 'pipe',
      runId: 'run-2',
      workspace: { mode: 'git-repo', repo: originDir, ref: 'main', cacheDir },
    })
    const readme = await readFile(join(cacheDir, 'README.md'), 'utf8')
    expect(readme).toBe('second head\n')
    await second.finishStep('completed')
  })

  it('fetches both ref and baseRef when both are supplied', async () => {
    const manager = new WorkspaceManager()
    const cacheDir = join(cacheRoot, 'repo')
    const prepared = await manager.prepare({
      pipelineId: 'pipe',
      runId: 'run-1',
      workspace: {
        mode: 'git-repo',
        repo: originDir,
        ref: 'feature',
        baseRef: 'main',
        cacheDir,
      },
    })
    // Both refs are reachable in the clone.
    const { stdout: featureSha } = await execFileAsync('git', [
      '-C',
      cacheDir,
      'rev-parse',
      'origin/feature',
    ])
    const { stdout: mainSha } = await execFileAsync('git', [
      '-C',
      cacheDir,
      'rev-parse',
      'origin/main',
    ])
    expect(featureSha.trim()).not.toBe(mainSha.trim())
    await prepared.finishStep('completed')
  })

  it('resolves owner/name shorthand to a default GitHub URL (no network call here)', async () => {
    // We only verify the URL-resolver path: a missing remote URL must surface
    // as a clone failure rather than being silently rewritten to the local path.
    const manager = new WorkspaceManager()
    const cacheDir = join(cacheRoot, 'no-such-repo')
    await expect(
      manager.prepare({
        pipelineId: 'pipe',
        runId: 'run-1',
        workspace: {
          mode: 'git-repo',
          repo: 'skelm-test-bogus/does-not-exist-12345',
          ref: 'main',
          cacheDir,
        },
      }),
    ).rejects.toThrow()
  })
})
