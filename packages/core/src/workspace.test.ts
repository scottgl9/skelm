import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BackendRegistry, type SkelmBackend } from './backend.js'
import { agent, code, pipeline } from './builders.js'
import { runPipeline } from './runner.js'
import { WorkspaceManager } from './workspace.js'

describe('WorkspaceManager', () => {
  it('reuses persistent workspaces across runs and writes metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skelm-workspaces-'))
    const manager = new WorkspaceManager({ persistentBase: dir })
    try {
      const first = await manager.prepare({
        pipelineId: 'pipe',
        runId: 'run-1',
        workspace: { mode: 'persistent', name: 'main' },
      })
      const firstPath = first.handle.path
      await first.finishStep('completed')
      await first.finishRun('completed')

      const second = await manager.prepare({
        pipelineId: 'pipe',
        runId: 'run-2',
        workspace: { mode: 'persistent', name: 'main' },
      })
      expect(second.handle.path).toBe(firstPath)
      await second.finishStep('completed')
      await second.finishRun('completed')

      const listed = await manager.listPersistentWorkspaces()
      expect(listed).toEqual([
        expect.objectContaining({
          pipelineId: 'pipe',
          name: 'main',
          path: firstPath,
        }),
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('waits for a persistent workspace lock to be released', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skelm-workspaces-lock-'))
    const manager = new WorkspaceManager({
      persistentBase: dir,
      waitTimeoutMs: 1_000,
      pollIntervalMs: 25,
    })
    try {
      const first = await manager.prepare({
        pipelineId: 'pipe',
        runId: 'run-1',
        workspace: { mode: 'persistent', name: 'locked' },
      })

      const startedAt = Date.now()
      const secondPromise = manager.prepare({
        pipelineId: 'pipe',
        runId: 'run-2',
        workspace: { mode: 'persistent', name: 'locked' },
      })

      await new Promise((resolve) => setTimeout(resolve, 150))
      await first.finishStep('completed')
      await first.finishRun('completed')

      const second = await secondPromise
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
      await second.finishStep('completed')
      await second.finishRun('completed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('agent workspaces in the runner', () => {
  it('sets agent cwd, exposes ctx.workspace to later steps, and scopes fs permissions to the workspace', async () => {
    const workspaceBase = await mkdtemp(join(tmpdir(), 'skelm-runner-workspaces-'))
    const registry = new BackendRegistry()
    const captured: Array<{
      cwd?: string
      fsRead?: readonly string[]
      fsWrite?: readonly string[]
    }> = []

    const backend: SkelmBackend = {
      id: 'workspace-backend',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'native',
      },
      async run(req) {
        captured.push({
          cwd: req.cwd,
          fsRead: req.permissions?.fsRead ? [...req.permissions.fsRead] : undefined,
          fsWrite: req.permissions?.fsWrite ? [...req.permissions.fsWrite] : undefined,
        })
        return { text: 'ok' }
      },
    }
    registry.register(backend)

    const wf = pipeline({
      id: 'workspace-runner',
      steps: [
        agent({
          id: 'work',
          backend: 'workspace-backend',
          prompt: 'hi',
          workspace: { mode: 'persistent', name: 'main' },
        }),
        code({
          id: 'inspect',
          run: async (ctx) => ({
            workspace: ctx.workspace?.path,
            exists: ctx.workspace ? await pathExists(ctx.workspace.path) : false,
          }),
        }),
      ],
    })

    try {
      const run = await runPipeline(wf, undefined, {
        backends: registry,
        workspaceManager: new WorkspaceManager({ persistentBase: workspaceBase }),
      })
      expect(run.status).toBe('completed')
      const out = run.output as { workspace: string; exists: boolean }
      expect(out.exists).toBe(true)
      expect(captured).toEqual([
        {
          cwd: out.workspace,
          fsRead: [out.workspace],
          fsWrite: [out.workspace],
        },
      ])
    } finally {
      await rm(workspaceBase, { recursive: true, force: true })
    }
  })

  it('cleans ephemeral workspaces on step end when configured', async () => {
    const workspaceBase = await mkdtemp(join(tmpdir(), 'skelm-ephemeral-workspaces-'))
    const registry = new BackendRegistry()
    const paths: string[] = []
    registry.register({
      id: 'workspace-backend',
      capabilities: {
        prompt: false,
        streaming: false,
        sessionLifecycle: false,
        mcp: false,
        skills: false,
        modelSelection: false,
        toolPermissions: 'native',
      },
      async run(req) {
        if (req.cwd !== undefined) {
          paths.push(req.cwd)
          await mkdir(join(req.cwd, 'scratch'), { recursive: true })
        }
        return { text: 'ok' }
      },
    })

    const wf = pipeline({
      id: 'workspace-ephemeral',
      steps: [
        agent({
          id: 'work',
          backend: 'workspace-backend',
          prompt: 'hi',
          workspace: { mode: 'ephemeral', cleanup: 'on-step-end' },
        }),
      ],
    })

    try {
      const run = await runPipeline(wf, undefined, {
        backends: registry,
        workspaceManager: new WorkspaceManager({ ephemeralBase: workspaceBase }),
      })
      expect(run.status).toBe('completed')
      expect(paths).toHaveLength(1)
      const [workspacePath] = paths
      if (workspacePath === undefined) {
        throw new Error('missing ephemeral workspace path')
      }
      expect(await pathExists(workspacePath)).toBe(false)
    } finally {
      await rm(workspaceBase, { recursive: true, force: true })
    }
  })
})

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
