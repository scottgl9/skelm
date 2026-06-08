import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../src/builders.js'
import { EventBus } from '../src/events.js'
import { ArtifactValidationError, MemoryRunStore } from '../src/run-store.js'
import { runPipeline } from '../src/runner.js'
import { WorkspaceManager } from '../src/workspace.js'

describe('ctx.artifacts binding', () => {
  it('persists a binary artifact and emits a tool.result event scoped to the step', async () => {
    const store = new MemoryRunStore()
    const events = new EventBus()
    const seen: Array<{ type: string; tool?: string; stepId?: string; size?: number }> = []
    events.subscribe((e) => {
      if (e.type === 'tool.result') {
        seen.push({
          type: e.type,
          tool: e.tool,
          stepId: e.stepId,
          size: (e.result as { size: number }).size,
        })
      }
    })

    const wf = pipeline({
      id: 'snapshot',
      steps: [
        code({
          id: 'capture',
          run: async (ctx) => {
            const desc = await ctx.artifacts?.put({
              name: 'screen.png',
              mimeType: 'image/png',
              data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            })
            return { artifactId: desc.artifactId, size: desc.size }
          },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, { store, events })
    expect(run.status).toBe('completed')
    const out = run.steps?.[0]?.output as { artifactId: string; size: number } | undefined
    expect(out?.size).toBe(4)

    // The artifact actually landed in the store.
    const fetched = await store.getArtifact({
      runId: run.runId,
      artifactId: out?.artifactId,
    })
    expect(fetched).not.toBeNull()
    expect(fetched?.descriptor.stepId).toBe('capture')
    expect(Array.from(fetched?.data)).toEqual([0x89, 0x50, 0x4e, 0x47])

    // The audit/event trail recorded a tool.result for the put.
    expect(seen).toEqual([
      { type: 'tool.result', tool: 'artifacts.put', stepId: 'capture', size: 4 },
    ])
  })

  it('does not write the artifact bytes into the run event payload', async () => {
    // Adversarial: large binary blobs must not leak through the event log.
    const store = new MemoryRunStore()
    const events = new EventBus()
    const captured: unknown[] = []
    events.subscribe((e) => captured.push(e))

    const big = new Uint8Array(64 * 1024).fill(0x42)
    const wf = pipeline({
      id: 'big-snap',
      steps: [
        code({
          id: 'capture',
          run: async (ctx) => {
            await ctx.artifacts?.put({
              name: 'big.bin',
              mimeType: 'application/octet-stream',
              data: big,
            })
            return null
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { store, events })
    expect(run.status).toBe('completed')

    // No event payload should carry the bytes themselves.
    const serialized = JSON.stringify(captured)
    // The pattern "BBBB..." would appear if base64-or-utf8 leaked through.
    expect(serialized.includes('B'.repeat(64))).toBe(false)
    expect(serialized.length).toBeLessThan(10_000)
  })

  it('materializes an artifact into the current workspace and emits descriptor-only events', async () => {
    const workspaceBase = await mkdtemp(join(tmpdir(), 'skelm-artifact-materialize-'))
    const store = new MemoryRunStore()
    const events = new EventBus()
    const captured: unknown[] = []
    events.subscribe((e) => captured.push(e))

    try {
      const wf = pipeline({
        id: 'materialize-report',
        steps: [
          code({
            id: 'write-report',
            workspace: { mode: 'ephemeral', cleanup: 'never' },
            run: async (ctx) => {
              const desc = await ctx.artifacts?.put({
                name: 'report.txt',
                mimeType: 'text/plain',
                data: 'secret report bytes',
              })
              const materialized = await ctx.artifacts?.materialize(desc, {
                path: 'exports/report.txt',
              })
              return { path: materialized?.path, bytesWritten: materialized?.bytesWritten }
            },
          }),
        ],
      })

      const run = await runPipeline(wf, undefined, {
        store,
        events,
        workspaceManager: new WorkspaceManager({ ephemeralBase: workspaceBase }),
      })
      expect(run.status).toBe('completed')
      const out = run.output as { path: string; bytesWritten: number }
      expect(out.bytesWritten).toBe(19)
      expect(await readFile(out.path, 'utf8')).toBe('secret report bytes')

      const serialized = JSON.stringify(captured)
      expect(serialized.includes('secret report bytes')).toBe(false)
      expect(serialized).toContain('artifacts.materialize')
      expect(serialized).toContain('exports/report.txt')
    } finally {
      await rm(workspaceBase, { recursive: true, force: true })
    }
  })

  it('overwrites an existing materialized artifact when explicitly allowed', async () => {
    const workspaceBase = await mkdtemp(join(tmpdir(), 'skelm-artifact-overwrite-'))
    const store = new MemoryRunStore()

    try {
      const wf = pipeline({
        id: 'overwrite-report',
        steps: [
          code({
            id: 'write-report',
            workspace: { mode: 'ephemeral', cleanup: 'never' },
            run: async (ctx) => {
              if (ctx.workspace === undefined) throw new Error('missing workspace')
              const target = join(ctx.workspace.path, 'exports', 'report.txt')
              await mkdir(join(ctx.workspace.path, 'exports'), { recursive: true })
              await writeFile(target, 'old bytes')
              const desc = await ctx.artifacts?.put({
                name: 'report.txt',
                mimeType: 'text/plain',
                data: 'new bytes',
              })
              const materialized = await ctx.artifacts?.materialize(desc, {
                path: 'exports/report.txt',
                overwrite: true,
              })
              return { path: materialized?.path, bytesWritten: materialized?.bytesWritten }
            },
          }),
        ],
      })

      const run = await runPipeline(wf, undefined, {
        store,
        workspaceManager: new WorkspaceManager({ ephemeralBase: workspaceBase }),
      })
      expect(run.status).toBe('completed')
      const out = run.output as { path: string; bytesWritten: number }
      expect(out.bytesWritten).toBe(9)
      expect(await readFile(out.path, 'utf8')).toBe('new bytes')
    } finally {
      await rm(workspaceBase, { recursive: true, force: true })
    }
  })

  it('rejects materialization without a declared workspace', async () => {
    const store = new MemoryRunStore()

    const wf = pipeline({
      id: 'missing-workspace-report',
      steps: [
        code({
          id: 'write-report',
          run: async (ctx) => {
            const desc = await ctx.artifacts?.put({
              name: 'report.txt',
              mimeType: 'text/plain',
              data: 'safe',
            })
            await ctx.artifacts?.materialize(desc, { path: 'report.txt' })
          },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined, { store })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('ArtifactMaterializationError')
    expect(run.error?.message).toContain('requires the current step to declare a workspace')
  })

  it('rejects materializing an artifact from a different run', async () => {
    const workspaceBase = await mkdtemp(join(tmpdir(), 'skelm-artifact-cross-run-'))
    const store = new MemoryRunStore()
    const other = await store.putArtifact({
      runId: 'other-run',
      stepId: 'capture',
      name: 'report.txt',
      mimeType: 'text/plain',
      data: 'secret',
    })

    try {
      const wf = pipeline({
        id: 'cross-run-report',
        steps: [
          code({
            id: 'write-report',
            workspace: { mode: 'ephemeral', cleanup: 'never' },
            run: async (ctx) => {
              await ctx.artifacts?.materialize(other, { path: 'report.txt' })
            },
          }),
        ],
      })

      const run = await runPipeline(wf, undefined, {
        store,
        workspaceManager: new WorkspaceManager({ ephemeralBase: workspaceBase }),
      })
      expect(run.status).toBe('failed')
      expect(run.error?.name).toBe('ArtifactMaterializationError')
      expect(run.error?.message).toContain('not current run')
    } finally {
      await rm(workspaceBase, { recursive: true, force: true })
    }
  })

  it('rejects materialization paths that traverse outside the workspace', async () => {
    const workspaceBase = await mkdtemp(join(tmpdir(), 'skelm-artifact-traversal-'))
    const store = new MemoryRunStore()

    try {
      const wf = pipeline({
        id: 'traversal-report',
        steps: [
          code({
            id: 'write-report',
            workspace: { mode: 'ephemeral', cleanup: 'never' },
            run: async (ctx) => {
              const desc = await ctx.artifacts?.put({
                name: 'report.txt',
                mimeType: 'text/plain',
                data: 'safe',
              })
              await ctx.artifacts?.materialize(desc, { path: '../escape.txt' })
            },
          }),
        ],
      })

      const run = await runPipeline(wf, undefined, {
        store,
        workspaceManager: new WorkspaceManager({ ephemeralBase: workspaceBase }),
      })
      expect(run.status).toBe('failed')
      expect(run.error?.name).toBe('ArtifactValidationError')
      expect(run.error?.message).toContain('parent segments')
    } finally {
      await rm(workspaceBase, { recursive: true, force: true })
    }
  })

  it('rejects materialization through a symlink that escapes the workspace', async () => {
    const workspaceBase = await mkdtemp(join(tmpdir(), 'skelm-artifact-symlink-'))
    const outside = await mkdtemp(join(tmpdir(), 'skelm-artifact-outside-'))
    const store = new MemoryRunStore()

    try {
      const wf = pipeline({
        id: 'symlink-report',
        steps: [
          code({
            id: 'write-report',
            workspace: { mode: 'ephemeral', cleanup: 'never' },
            run: async (ctx) => {
              if (ctx.workspace === undefined) throw new Error('missing workspace')
              await symlink(outside, join(ctx.workspace.path, 'escape'))
              const desc = await ctx.artifacts?.put({
                name: 'report.txt',
                mimeType: 'text/plain',
                data: 'safe',
              })
              await ctx.artifacts?.materialize(desc, { path: 'escape/report.txt' })
            },
          }),
        ],
      })

      const run = await runPipeline(wf, undefined, {
        store,
        workspaceManager: new WorkspaceManager({ ephemeralBase: workspaceBase }),
      })
      expect(run.status).toBe('failed')
      expect(run.error?.message).toContain('parent escapes')
    } finally {
      await rm(workspaceBase, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects overwrite materialization through a symlink target', async () => {
    const workspaceBase = await mkdtemp(join(tmpdir(), 'skelm-artifact-overwrite-symlink-'))
    const outside = await mkdtemp(join(tmpdir(), 'skelm-artifact-overwrite-outside-'))
    const store = new MemoryRunStore()

    try {
      const wf = pipeline({
        id: 'overwrite-symlink-report',
        steps: [
          code({
            id: 'write-report',
            workspace: { mode: 'ephemeral', cleanup: 'never' },
            run: async (ctx) => {
              if (ctx.workspace === undefined) throw new Error('missing workspace')
              await mkdir(join(ctx.workspace.path, 'exports'), { recursive: true })
              await writeFile(join(outside, 'report.txt'), 'outside')
              await symlink(
                join(outside, 'report.txt'),
                join(ctx.workspace.path, 'exports', 'report.txt'),
              )
              const desc = await ctx.artifacts?.put({
                name: 'report.txt',
                mimeType: 'text/plain',
                data: 'safe',
              })
              await ctx.artifacts?.materialize(desc, {
                path: 'exports/report.txt',
                overwrite: true,
              })
            },
          }),
        ],
      })

      const run = await runPipeline(wf, undefined, {
        store,
        workspaceManager: new WorkspaceManager({ ephemeralBase: workspaceBase }),
      })
      expect(run.status).toBe('failed')
      expect(run.error?.message).toContain('target escapes')
      expect(await readFile(join(outside, 'report.txt'), 'utf8')).toBe('outside')
    } finally {
      await rm(workspaceBase, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects invalid artifact names before storing bytes', async () => {
    const store = new MemoryRunStore()
    await expect(
      store.putArtifact({
        runId: 'r',
        name: '../secret.txt',
        mimeType: 'text/plain',
        data: 'secret',
      }),
    ).rejects.toBeInstanceOf(ArtifactValidationError)
  })
})
