/**
 * Plan §4.4: reapStaleEphemeralWorkspaces deletes orphan ephemeral
 * workspaces left by crashed runs without touching unrelated content
 * in the ephemeral base. The gateway calls this after recovery on
 * every start so disk doesn't grow unbounded across crash/restart
 * cycles.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceManager } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let base: string

async function writeMetadata(
  dir: string,
  mode: 'ephemeral' | 'persistent',
  lastAccessAt: number,
): Promise<void> {
  await mkdir(join(dir, '.skelm'), { recursive: true })
  await writeFile(
    join(dir, '.skelm', 'workspace.json'),
    JSON.stringify({
      version: 1,
      pipelineId: 'p',
      mode,
      createdAt: lastAccessAt,
      lastAccessAt,
    }),
  )
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'skelm-reap-test-'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('WorkspaceManager.reapStaleEphemeralWorkspaces (plan §4.4)', () => {
  it('reaps ephemeral dirs whose lastAccessAt is past the grace window', async () => {
    const stale = await mkdtemp(join(base, 'stale-'))
    await writeMetadata(stale, 'ephemeral', Date.now() - 7 * 24 * 60 * 60 * 1000)

    const mgr = new WorkspaceManager({ ephemeralBase: base })
    const result = await mgr.reapStaleEphemeralWorkspaces({ staleAfterMs: 1000 })
    expect(result.reaped).toContain(stale)
    expect(await readdir(base)).not.toContain(stale.split('/').pop())
  })

  it('leaves fresh ephemeral dirs alone', async () => {
    const fresh = await mkdtemp(join(base, 'fresh-'))
    await writeMetadata(fresh, 'ephemeral', Date.now())

    const mgr = new WorkspaceManager({ ephemeralBase: base })
    const result = await mgr.reapStaleEphemeralWorkspaces({ staleAfterMs: 60_000 })
    expect(result.reaped).not.toContain(fresh)
  })

  it('refuses to touch persistent dirs even when old', async () => {
    const persistent = await mkdtemp(join(base, 'persistent-'))
    await writeMetadata(persistent, 'persistent', 0)

    const mgr = new WorkspaceManager({ ephemeralBase: base })
    const result = await mgr.reapStaleEphemeralWorkspaces({ staleAfterMs: 1000 })
    expect(result.reaped).not.toContain(persistent)
  })

  it('ignores directories without skelm metadata (operator-owned tmp content)', async () => {
    // A non-skelm tmpdir entry — simulate an unrelated tool's working dir.
    const unrelated = await mkdtemp(join(base, 'unrelated-'))
    await writeFile(join(unrelated, 'some-other-file.txt'), 'hi')

    const mgr = new WorkspaceManager({ ephemeralBase: base })
    const result = await mgr.reapStaleEphemeralWorkspaces({ staleAfterMs: 0 })
    expect(result.reaped).toEqual([])
    // Untouched on disk.
    const remaining = await readdir(base)
    expect(remaining).toContain(unrelated.split('/').pop())
  })

  it('returns empty when the base does not exist', async () => {
    const mgr = new WorkspaceManager({ ephemeralBase: '/nonexistent-skelm-reap-test-path' })
    const result = await mgr.reapStaleEphemeralWorkspaces({})
    expect(result.reaped).toEqual([])
  })
})
