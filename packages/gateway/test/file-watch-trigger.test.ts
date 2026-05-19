import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TriggerCoordinator } from '../src/index.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skelm-file-watch-'))
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

describe('file-watch trigger', () => {
  it('fires with the expected payload when a file is created', async () => {
    const seen: Array<{ path: string; event: string; watchedPath: string; firedAt: string }> = []
    const coordinator = new TriggerCoordinator({
      onFire: async (ctx) => {
        seen.push(ctx.payload as { path: string; event: string; watchedPath: string; firedAt: string })
      },
    })
    coordinator.register({
      kind: 'file-watch',
      id: 'watch-create',
      workflowId: 'wf',
      path: tempDir,
    })

    const createdPath = join(tempDir, 'created.txt')
    await writeFile(createdPath, 'hello')
    const payload = await waitFor(() => seen[0])

    expect(payload.path).toBe(createdPath)
    expect(payload.event).toBe('create')
    expect(payload.watchedPath).toBe(tempDir)
    expect(payload.firedAt).toEqual(expect.any(String))
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

    const filePath = join(tempDir, 'debounce.txt')
    await writeFile(filePath, 'one')
    await writeFile(filePath, 'two')
    await writeFile(filePath, 'three')
    await waitFor(() => (seen.length === 1 ? seen[0] : undefined))

    expect(seen).toHaveLength(1)
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
})
