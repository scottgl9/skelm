import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TriggerCoordinator } from '../src/index.js'
import { FileWatchTrigger } from '../src/triggers/file-watcher.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skelm-file-watch-'))
  tempDir = await realpath(tempDir)
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = fn()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for file-watch trigger')
}

async function waitForWatcherReady(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100))
}

function forcePollingFallback(watcher: FileWatchTrigger): void {
  const rawWatcher = (
    watcher as unknown as { watcher?: { emit?: (event: string, err: Error) => void } }
  ).watcher
  rawWatcher?.emit?.('error', new Error('ENOSPC: System limit for number of file watchers reached'))
}

describe('file-watch trigger', () => {
  it('fires with the expected payload when a file is created', async () => {
    const seen: Array<{ path: string; event: string; watchedPath: string; firedAt: string }> = []
    const coordinator = new TriggerCoordinator({
      onFire: async (ctx) => {
        seen.push(
          ctx.payload as { path: string; event: string; watchedPath: string; firedAt: string },
        )
      },
    })
    coordinator.register({
      kind: 'file-watch',
      id: 'watch-create',
      workflowId: 'wf',
      path: tempDir,
    })

    await waitForWatcherReady()

    const createdPath = join(tempDir, 'created.txt')
    await writeFile(createdPath, 'hello')
    const payload = await waitFor(() => seen[0])

    expect(payload.path).toBe(createdPath)
    expect(payload.event).toBe('create')
    expect(payload.watchedPath).toBe(tempDir)
    expect(payload.firedAt).toEqual(expect.any(String))
    await coordinator.stop()
  })

  it('does not fire create events for existing files on registration', async () => {
    const seen: Array<{ path: string; event: string }> = []
    const existingPath = join(tempDir, 'existing.txt')
    await writeFile(existingPath, 'already here')
    const coordinator = new TriggerCoordinator({
      onFire: async (ctx) => {
        seen.push(ctx.payload as { path: string; event: string })
      },
    })
    coordinator.register({
      kind: 'file-watch',
      id: 'watch-existing',
      workflowId: 'wf',
      path: tempDir,
    })

    await waitForWatcherReady()
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(seen).toHaveLength(0)

    const createdPath = join(tempDir, 'created-after-ready.txt')
    await writeFile(createdPath, 'new')
    const payload = await waitFor(() => seen[0])

    expect(payload.path).toBe(createdPath)
    expect(payload.event).toBe('create')
    await coordinator.stop()
  })

  it('debounces rapid writes into a single fire', async () => {
    const seen: Array<{ path: string; event: string }> = []
    const coordinator = new TriggerCoordinator({
      onFire: async (ctx) => {
        seen.push(ctx.payload as { path: string; event: string })
      },
    })
    coordinator.register({
      kind: 'file-watch',
      id: 'watch-debounce',
      workflowId: 'wf',
      path: tempDir,
      debounceMs: 75,
    })

    await waitForWatcherReady()

    const filePath = join(tempDir, 'debounce.txt')
    await writeFile(filePath, 'one')
    await writeFile(filePath, 'two')
    await writeFile(filePath, 'three')
    await waitFor(() => (seen.length === 1 ? seen[0] : undefined))

    expect(seen).toHaveLength(1)
    await coordinator.stop()
  })

  it('reports the watched file path, not "/dir/file/file", on single-file watch', async () => {
    const seen: Array<{ path: string; event: string; watchedPath: string }> = []
    const coordinator = new TriggerCoordinator({
      onFire: async (ctx) => {
        seen.push(ctx.payload as { path: string; event: string; watchedPath: string })
      },
    })
    const target = join(tempDir, 'single.txt')
    await writeFile(target, 'orig')
    coordinator.register({
      kind: 'file-watch',
      id: 'watch-single-file',
      workflowId: 'wf',
      path: target,
    })

    await waitForWatcherReady()

    await writeFile(target, 'changed')
    const payload = await waitFor(() => seen[0])

    expect(payload.path).toBe(target)
    expect(payload.watchedPath).toBe(target)
    await coordinator.stop()
  })

  it('stops firing after unregister', async () => {
    const seen: Array<{ path: string; event: string }> = []
    const coordinator = new TriggerCoordinator({
      onFire: async (ctx) => {
        seen.push(ctx.payload as { path: string; event: string })
      },
    })
    coordinator.register({
      kind: 'file-watch',
      id: 'watch-stop',
      workflowId: 'wf',
      path: tempDir,
    })

    await waitForWatcherReady()

    const firstPath = join(tempDir, 'before-stop.txt')
    await writeFile(firstPath, 'before')
    await waitFor(() => seen[0])

    coordinator.unregister('watch-stop')
    const stoppedCount = seen.length
    const secondPath = join(tempDir, 'after-stop.txt')
    await writeFile(secondPath, 'after')
    await unlink(secondPath).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(seen).toHaveLength(stoppedCount)
    await coordinator.stop()
  })

  it('records lastError when the watched path does not exist', async () => {
    const coordinator = new TriggerCoordinator({ onFire: async () => {} })
    const reg = coordinator.register({
      kind: 'file-watch',
      id: 'watch-missing',
      workflowId: 'wf',
      path: join(tempDir, 'missing'),
    })

    expect(reg.lastError).toMatch(/file-watch start failed/)
    expect(reg.lastError).toMatch(/ENOENT|no such file/i)
    await coordinator.stop()
  })

  it('routes async watcher errors through onError instead of escaping', async () => {
    const errors: Error[] = []
    const watcher = new FileWatchTrigger({ path: tempDir })
    watcher.start(
      () => {},
      (err) => {
        errors.push(err)
      },
    )

    forcePollingFallback(watcher)

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toMatch(/ENOSPC/)
    watcher.stop()
  })

  it('keeps delete and empty-directory events when ENOSPC forces polling fallback', async () => {
    const seen: Array<{ path: string; event: string }> = []
    const target = join(tempDir, 'single.txt')
    await writeFile(target, 'orig')

    const fileWatcher = new FileWatchTrigger({ path: target })
    fileWatcher.start((payload) => {
      seen.push({ path: payload.path, event: payload.event })
    })

    forcePollingFallback(fileWatcher)
    await unlink(target)

    const fileDelete = await waitFor(() =>
      seen.find((payload) => payload.path === target && payload.event === 'delete'),
    )
    expect(fileDelete).toEqual({ path: target, event: 'delete' })

    fileWatcher.stop()
    seen.length = 0

    const dirWatcher = new FileWatchTrigger({ path: tempDir })
    dirWatcher.start((payload) => {
      seen.push({ path: payload.path, event: payload.event })
    })

    forcePollingFallback(dirWatcher)

    const emptyDir = join(tempDir, 'empty-dir')
    await mkdir(emptyDir)
    const dirCreate = await waitFor(() =>
      seen.find((payload) => payload.path === emptyDir && payload.event === 'create'),
    )
    expect(dirCreate).toEqual({ path: emptyDir, event: 'create' })

    await rm(emptyDir, { recursive: true, force: true })
    const dirDelete = await waitFor(() =>
      seen.find((payload) => payload.path === emptyDir && payload.event === 'delete'),
    )
    expect(dirDelete).toEqual({ path: emptyDir, event: 'delete' })

    dirWatcher.stop()
  })
})
