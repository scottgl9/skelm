import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../src/builders.js'
import { RunCancelledError } from '../src/errors.js'
import { EventBus, type RunEvent } from '../src/events.js'
import type { Context, Pipeline, SpawnedTaskHandle, TaskRecord } from '../src/index.js'
import { MemoryRunStore } from '../src/run-store.js'
import { runPipeline } from '../src/runner.js'

const registryOf = (map: Record<string, Pipeline>) => (id: string) => map[id]

const echo = pipeline({
  id: 'echo',
  steps: [code({ id: 'reply', run: (ctx) => ({ echoed: ctx.input }) })],
})

const slow = pipeline({
  id: 'slow',
  steps: [
    code({
      id: 'sleep',
      run: (ctx) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve('slow-done'), 3000)
          timer.unref?.()
          ctx.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new RunCancelledError())
            },
            { once: true },
          )
        }),
    }),
  ],
})

function spawner(run: (ctx: Context) => unknown) {
  return pipeline({
    id: 'spawner',
    steps: [code({ id: 'spawn-step', permissions: { delegation: ['*'] }, run })],
  })
}

describe('ctx.tasks lifecycle', () => {
  it('spawn + wait: creates a TaskRecord with lineage and completes it from the child run', async () => {
    const store = new MemoryRunStore()
    const events = new EventBus()
    const taskEvents: RunEvent[] = []
    events.subscribe((e) => {
      if (e.type.startsWith('task.')) taskEvents.push(e)
    })
    const parent = spawner(async (ctx) => {
      const handle = await ctx.tasks?.spawn({
        workflowId: 'echo',
        input: 7,
        deliveryTarget: { kind: 'slack', target: '#ops' },
      })
      if (handle === undefined) throw new Error('tasks handle missing')
      const task = await ctx.tasks?.wait(handle.taskId)
      return { handle, task }
    })
    const run = await runPipeline(parent, undefined, {
      store,
      events,
      pipelineRegistry: registryOf({ echo }),
    })
    expect(run.status).toBe('completed')
    const { handle, task } = run.output as { handle: SpawnedTaskHandle; task: TaskRecord }
    expect(handle.taskId).toMatch(/^task_/)
    expect(handle.childRunId).toBeTruthy()
    expect(task.status).toBe('completed')
    expect(task.workflowId).toBe('echo')
    expect(task.childRunId).toBe(handle.childRunId)
    expect(task.parentRunId).toBe(run.runId)
    expect(task.parentStepId).toBe('spawn-step')
    expect(task.deliveryTarget).toEqual({ kind: 'slack', target: '#ops' })

    const childRun = await store.getRun(handle.childRunId)
    expect(childRun?.status).toBe('completed')
    expect(childRun?.parentRunId).toBe(run.runId)
    expect(childRun?.parentStepId).toBe('spawn-step')
    expect(childRun?.taskId).toBe(handle.taskId)

    const types = taskEvents.map((e) => e.type)
    expect(types).toContain('task.created')
    expect(types).toContain('task.completed')
  })

  it('wait surfaces a failed child as a failed task record', async () => {
    const boom = pipeline({
      id: 'boom',
      steps: [
        code({
          id: 'explode',
          run: () => {
            throw new Error('child blew up')
          },
        }),
      ],
    })
    const parent = spawner(async (ctx) => {
      const handle = await ctx.tasks?.spawn({ workflowId: 'boom' })
      if (handle === undefined) throw new Error('tasks handle missing')
      return await ctx.tasks?.wait(handle.taskId)
    })
    const run = await runPipeline(parent, undefined, {
      store: new MemoryRunStore(),
      pipelineRegistry: registryOf({ boom }),
    })
    expect(run.status).toBe('completed')
    const task = run.output as TaskRecord
    expect(task.status).toBe('failed')
    expect(task.error?.message).toContain('child blew up')
  })

  it('cancel aborts the spawned child run and marks the task cancelled', async () => {
    const store = new MemoryRunStore()
    const parent = spawner(async (ctx) => {
      const handle = await ctx.tasks?.spawn({ workflowId: 'slow' })
      if (handle === undefined) throw new Error('tasks handle missing')
      await ctx.tasks?.cancel(handle.taskId)
      const task = await ctx.tasks?.wait(handle.taskId)
      return { handle, task }
    })
    const run = await runPipeline(parent, undefined, {
      store,
      pipelineRegistry: registryOf({ slow }),
    })
    expect(run.status).toBe('completed')
    const { handle, task } = run.output as { handle: SpawnedTaskHandle; task: TaskRecord }
    expect(task.status).toBe('cancelled')
    const childRun = await store.getRun(handle.childRunId)
    expect(childRun?.status).toBe('cancelled')
  })

  it('stream delivers the spawned child run events live', async () => {
    const parent = spawner(async (ctx) => {
      const handle = await ctx.tasks?.spawn({ workflowId: 'echo', input: 1 })
      if (handle === undefined || ctx.tasks === undefined) throw new Error('tasks handle missing')
      const seen: string[] = []
      const unsubscribe = ctx.tasks.stream(handle.taskId, (event) => {
        seen.push(event.type)
      })
      await ctx.tasks.wait(handle.taskId)
      unsubscribe()
      return seen
    })
    const run = await runPipeline(parent, undefined, {
      store: new MemoryRunStore(),
      events: new EventBus(),
      pipelineRegistry: registryOf({ echo }),
    })
    expect(run.status).toBe('completed')
    const seen = run.output as string[]
    expect(seen).toContain('step.complete')
    expect(seen).toContain('run.completed')
  })

  it('wait/cancel/stream reject for tasks this step did not spawn', async () => {
    const parent = spawner(async (ctx) => {
      const names: string[] = []
      try {
        await ctx.tasks?.wait('task_unknown')
        names.push('no-throw')
      } catch (err) {
        names.push((err as Error).name)
      }
      try {
        await ctx.tasks?.cancel('task_unknown')
        names.push('no-throw')
      } catch (err) {
        names.push((err as Error).name)
      }
      try {
        ctx.tasks?.stream('task_unknown', () => {})
        names.push('no-throw')
      } catch (err) {
        names.push((err as Error).name)
      }
      return names
    })
    const run = await runPipeline(parent, undefined, {
      store: new MemoryRunStore(),
      pipelineRegistry: registryOf({ echo }),
    })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual([
      'TaskOrchestrationError',
      'TaskOrchestrationError',
      'TaskOrchestrationError',
    ])
  })

  it('a spawned task is detached: it survives the parent run finishing', async () => {
    const store = new MemoryRunStore()
    let spawned: SpawnedTaskHandle | undefined
    const medium = pipeline({
      id: 'medium',
      steps: [
        code({
          id: 'pause',
          run: () => new Promise((resolve) => setTimeout(() => resolve('done'), 80)),
        }),
      ],
    })
    const parent = spawner(async (ctx) => {
      spawned = await ctx.tasks?.spawn({ workflowId: 'medium' })
      return spawned
    })
    const run = await runPipeline(parent, undefined, {
      store,
      pipelineRegistry: registryOf({ medium }),
    })
    expect(run.status).toBe('completed')
    expect(spawned).toBeDefined()
    const handle = spawned as SpawnedTaskHandle
    const inFlight = await store.getTask(handle.taskId)
    expect(inFlight?.status).toBe('running')
    // The detached child keeps running after the parent finished; poll until terminal.
    const deadline = Date.now() + 3000
    let task: TaskRecord | null = null
    while (Date.now() < deadline) {
      task = await store.getTask(handle.taskId)
      if (task !== null && task.status !== 'running' && task.status !== 'pending') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(task?.status).toBe('completed')
    expect((await store.getRun(handle.childRunId))?.status).toBe('completed')
  })

  it('ctx.tasks is absent when no run store is wired', async () => {
    const parent = pipeline({
      id: 'no-store',
      steps: [code({ id: 'check', run: (ctx) => ctx.tasks === undefined })],
    })
    const run = await runPipeline(parent, undefined, { pipelineRegistry: registryOf({ echo }) })
    expect(run.status).toBe('completed')
    expect(run.output).toBe(true)
  })
})
