import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRunStore, SqliteRunStore, code, pipeline } from '@skelm/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Gateway } from '../../src/index.js'
import { bootGatewayWithRetry } from '../utils/boot-gateway.js'

let stateDir: string
let projectRoot: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-tasks-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-tasks-root-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
})

const wf = pipeline({
  id: 'b',
  steps: [code({ id: 'one', run: () => ({ ok: true }) })],
})

const slowWf = pipeline({
  id: 'slow',
  steps: [
    code({
      id: 'wait',
      run: async () => {
        await new Promise((r) => setTimeout(r, 50))
        return { done: true }
      },
    }),
  ],
})

async function bootGateway(
  opts: { bearer?: boolean; store?: MemoryRunStore } = {},
): Promise<{ gw: Gateway; base: string; store: MemoryRunStore }> {
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  await fs.writeFile(join(projectRoot, 'workflows/b.workflow.ts'), 'export default {}')
  await fs.writeFile(join(projectRoot, 'workflows/slow.workflow.ts'), 'export default {}')
  const store = opts.store ?? new MemoryRunStore()
  const booted = await bootGatewayWithRetry((port) => ({
    stateDir,
    projectRoot,
    watchRegistries: false,
    enableHttp: true,
    httpPort: port,
    runStore: store,
    ...(opts.bearer === true && { token: 'sekret' }),
    loadWorkflow: async (id: string) => (id.includes('slow') ? slowWf : wf),
    config: {
      registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } },
      ...(opts.bearer === true && {
        server: { host: '127.0.0.1', port: 0, auth: { mode: 'bearer' as const } },
      }),
    },
  }))
  return { gw: booted.gw, base: booted.base, store }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('waitFor: timed out')
}

describe('/v1/tasks', () => {
  it('creates a task, dispatches a child run, and links them on completion', async () => {
    const { gw, base, store } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workflowId: 'workflows/b.workflow.ts',
          input: { n: 1 },
          deliveryTarget: { kind: 'slack', target: '#ops' },
        }),
      })
      expect(res.status).toBe(200)
      const task = await res.json()
      expect(task.taskId).toMatch(/^task_/)
      // A very fast child workflow can already be terminal by the time create
      // returns; either way the task is dispatched and linked.
      expect(['running', 'completed']).toContain(task.status)
      expect(task.childRunId).toMatch(/[a-f0-9-]{36}/)
      expect(task.deliveryTarget).toEqual({ kind: 'slack', target: '#ops' })

      // The child run carries the lineage stamp.
      await waitFor(async () => (await store.getRun(task.childRunId)) !== null)
      const childRun = await store.getRun(task.childRunId)
      expect(childRun?.taskId).toBe(task.taskId)

      // The task transitions to completed once the child run finishes.
      await waitFor(async () => {
        const t = await store.getTask(task.taskId)
        return t?.status === 'completed'
      })
      const completed = await store.getTask(task.taskId)
      expect(completed?.status).toBe('completed')
      expect(completed?.completedAt).toBeTruthy()

      // task.created event emitted on the child run bus.
      const evRes = await fetch(`${base}/v1/tasks/${task.taskId}/events`)
      expect(evRes.status).toBe(200)
      const { runId, events } = await evRes.json()
      expect(runId).toBe(task.childRunId)
      const types = (events as Array<{ type: string }>).map((e) => e.type)
      expect(types).toContain('task.created')
    } finally {
      await gw.stop()
    }
  })

  it('rejects creation with a missing workflowId (validation)', async () => {
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      })
      expect(res.status).toBe(400)
    } finally {
      await gw.stop()
    }
  })

  it('returns 404 when creating a task for an unknown workflow', async () => {
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: 'workflows/missing.workflow.ts' }),
      })
      expect(res.status).toBe(404)
    } finally {
      await gw.stop()
    }
  })

  it('lists and filters tasks', async () => {
    const { gw, base } = await bootGateway()
    try {
      const c = await fetch(`${base}/v1/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: 'workflows/b.workflow.ts' }),
      })
      const created = await c.json()

      const list = await fetch(`${base}/v1/tasks`)
      expect(list.status).toBe(200)
      const { tasks } = await list.json()
      expect(tasks.some((t: { taskId: string }) => t.taskId === created.taskId)).toBe(true)

      const get = await fetch(`${base}/v1/tasks/${created.taskId}`)
      expect(get.status).toBe(200)
      expect((await get.json()).taskId).toBe(created.taskId)

      const missing = await fetch(`${base}/v1/tasks/task_does-not-exist`)
      expect(missing.status).toBe(404)
    } finally {
      await gw.stop()
    }
  })

  it('cancels a running task and 409s on a terminal task', async () => {
    const { gw, base, store } = await bootGateway()
    try {
      const c = await fetch(`${base}/v1/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: 'workflows/slow.workflow.ts' }),
      })
      const task = await c.json()

      const cancel = await fetch(`${base}/v1/tasks/${task.taskId}/cancel`, { method: 'POST' })
      expect(cancel.status).toBe(200)
      expect((await cancel.json()).status).toBe('cancelled')

      // A second cancel is a conflict.
      const again = await fetch(`${base}/v1/tasks/${task.taskId}/cancel`, { method: 'POST' })
      expect(again.status).toBe(409)
      expect(await store.getTask(task.taskId)).toMatchObject({ status: 'cancelled' })
    } finally {
      await gw.stop()
    }
  })

  it('retries a cancelled task and 409s on a running task', async () => {
    const { gw, base } = await bootGateway()
    try {
      const c = await fetch(`${base}/v1/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: 'workflows/slow.workflow.ts' }),
      })
      const task = await c.json()

      // Retry while running -> 409.
      const tooEarly = await fetch(`${base}/v1/tasks/${task.taskId}/retry`, { method: 'POST' })
      expect(tooEarly.status).toBe(409)

      await fetch(`${base}/v1/tasks/${task.taskId}/cancel`, { method: 'POST' })
      const retry = await fetch(`${base}/v1/tasks/${task.taskId}/retry`, { method: 'POST' })
      expect(retry.status).toBe(200)
      const retried = await retry.json()
      expect(retried.taskId).not.toBe(task.taskId)
      expect(retried.retryOfTaskId).toBe(task.taskId)
      expect(retried.workflowId).toBe(task.workflowId)
    } finally {
      await gw.stop()
    }
  })

  it('rejects every task route without a bearer token (auth-failure)', async () => {
    const { gw, base } = await bootGateway({ bearer: true })
    try {
      const noAuth = await fetch(`${base}/v1/tasks`)
      expect(noAuth.status).toBe(401)

      const wrong = await fetch(`${base}/v1/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
        body: JSON.stringify({ workflowId: 'workflows/b.workflow.ts' }),
      })
      expect(wrong.status).toBe(401)

      const ok = await fetch(`${base}/v1/tasks`, { headers: { authorization: 'Bearer sekret' } })
      expect(ok.status).toBe(200)
    } finally {
      await gw.stop()
    }
  })
})

describe('/v1/lineage', () => {
  it('reconstructs a parent -> child -> grandchild chain', async () => {
    const { gw, base, store } = await bootGateway()
    try {
      // Seed a three-level lineage directly through the store so the test does
      // not depend on nested dispatch timing.
      await store.putRun({
        runId: 'root',
        pipelineId: 'p',
        status: 'completed',
        input: {},
        steps: [],
        output: undefined,
        error: undefined,
        startedAt: 1,
        completedAt: 2,
      })
      await store.putRun({
        runId: 'mid',
        pipelineId: 'p',
        status: 'completed',
        input: {},
        steps: [],
        output: undefined,
        error: undefined,
        startedAt: 3,
        completedAt: 4,
        parentRunId: 'root',
        taskId: 't-mid',
      })
      await store.putRun({
        runId: 'leaf',
        pipelineId: 'p',
        status: 'running',
        input: {},
        steps: [],
        output: undefined,
        error: undefined,
        startedAt: 5,
        completedAt: undefined,
        parentRunId: 'mid',
        taskId: 't-leaf',
      })
      await store.putTask({
        taskId: 't-mid',
        workflowId: 'wf',
        status: 'completed',
        parentRunId: 'root',
        childRunId: 'mid',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      await store.putTask({
        taskId: 't-leaf',
        workflowId: 'wf',
        status: 'running',
        parentRunId: 'mid',
        childRunId: 'leaf',
        createdAt: '2026-01-01T00:00:01.000Z',
      })

      const res = await fetch(`${base}/v1/lineage/mid`)
      expect(res.status).toBe(200)
      const lineage = await res.json()
      expect(lineage.runId).toBe('mid')
      expect(lineage.ancestors.map((a: { runId: string }) => a.runId)).toEqual(['root'])
      expect(lineage.descendants).toHaveLength(1)
      expect(lineage.descendants[0].runId).toBe('leaf')
      expect(lineage.descendants[0].taskId).toBe('t-leaf')
    } finally {
      await gw.stop()
    }
  })

  it('surfaces synchronous fanout children that are runs without tasks', async () => {
    const { gw, base, store } = await bootGateway()
    try {
      await store.putRun({
        runId: 'parent',
        pipelineId: 'orchestrator',
        status: 'completed',
        input: {},
        steps: [],
        output: undefined,
        error: undefined,
        startedAt: 1,
        completedAt: 2,
      })
      // ctx.workflows.fanout over N children: each stamps parentRunId/parentStepId
      // on its child RUN but creates no TaskRecord.
      const n = 4
      for (let i = 0; i < n; i++) {
        await store.putRun({
          runId: `child-${i}`,
          pipelineId: 'worker',
          status: 'completed',
          input: {},
          steps: [],
          output: undefined,
          error: undefined,
          startedAt: 10 + i,
          completedAt: 11 + i,
          parentRunId: 'parent',
          parentStepId: 'fanout-step',
        })
      }

      const res = await fetch(`${base}/v1/lineage/parent`)
      expect(res.status).toBe(200)
      const lineage = await res.json()
      expect(lineage.descendants).toHaveLength(n)
      const ids = lineage.descendants.map((d: { runId: string }) => d.runId).sort()
      expect(ids).toEqual(['child-0', 'child-1', 'child-2', 'child-3'])
      for (const d of lineage.descendants) {
        expect(d.pipelineId).toBe('worker')
        expect(d.parentStepId).toBe('fanout-step')
      }
    } finally {
      await gw.stop()
    }
  })

  it('does not double-count a detached task whose child run also has parentRunId', async () => {
    const { gw, base, store } = await bootGateway()
    try {
      await store.putRun({
        runId: 'parent',
        pipelineId: 'p',
        status: 'completed',
        input: {},
        steps: [],
        output: undefined,
        error: undefined,
        startedAt: 1,
        completedAt: 2,
      })
      // A detached ctx.tasks.spawn child: it has BOTH a TaskRecord and a child
      // run that records parentRunId. It must appear exactly once.
      await store.putRun({
        runId: 'detached-child',
        pipelineId: 'p',
        status: 'running',
        input: {},
        steps: [],
        output: undefined,
        error: undefined,
        startedAt: 3,
        completedAt: undefined,
        parentRunId: 'parent',
        parentStepId: 'spawn-step',
        taskId: 'task-1',
      })
      await store.putTask({
        taskId: 'task-1',
        workflowId: 'wf',
        status: 'running',
        parentRunId: 'parent',
        parentStepId: 'spawn-step',
        childRunId: 'detached-child',
        createdAt: '2026-01-01T00:00:00.000Z',
      })

      const res = await fetch(`${base}/v1/lineage/parent`)
      expect(res.status).toBe(200)
      const lineage = await res.json()
      expect(lineage.descendants).toHaveLength(1)
      expect(lineage.descendants[0].runId).toBe('detached-child')
      expect(lineage.descendants[0].taskId).toBe('task-1')
    } finally {
      await gw.stop()
    }
  })

  it('caps depth and survives a parentRunId cycle on the run-derived path', async () => {
    const { gw, base, store } = await bootGateway()
    try {
      // Two runs that point at each other via parentRunId. The cycle guard
      // must terminate the descendant walk rather than loop forever.
      await store.putRun({
        runId: 'a',
        pipelineId: 'p',
        status: 'completed',
        input: {},
        steps: [],
        output: undefined,
        error: undefined,
        startedAt: 1,
        completedAt: 2,
        parentRunId: 'b',
      })
      await store.putRun({
        runId: 'b',
        pipelineId: 'p',
        status: 'completed',
        input: {},
        steps: [],
        output: undefined,
        error: undefined,
        startedAt: 3,
        completedAt: 4,
        parentRunId: 'a',
      })

      const res = await fetch(`${base}/v1/lineage/a`)
      expect(res.status).toBe(200)
      const lineage = await res.json()
      // a's child is b; b's only child would be a (the root), already visited,
      // so the tree stops at b with no infinite recursion.
      expect(lineage.descendants).toHaveLength(1)
      expect(lineage.descendants[0].runId).toBe('b')
      expect(lineage.descendants[0].children).toEqual([])
    } finally {
      await gw.stop()
    }
  })

  it('returns 404 for an unknown run', async () => {
    const { gw, base } = await bootGateway()
    try {
      const res = await fetch(`${base}/v1/lineage/nope`)
      expect(res.status).toBe(404)
    } finally {
      await gw.stop()
    }
  })
})

describe('task crash-restart durability', () => {
  it('reconciles a stale running task whose child run is terminal on reopen', async () => {
    const dbPath = join(stateDir, 'runs.sqlite')

    // First gateway: seed a 'running' task plus its child run, then close the
    // store without giving the task a chance to transition (simulated crash).
    const seed = new SqliteRunStore({ path: dbPath })
    await seed.putRun({
      runId: 'crash-child',
      pipelineId: 'p',
      status: 'completed',
      input: {},
      steps: [],
      output: { ok: true },
      error: undefined,
      startedAt: 1,
      completedAt: 2,
      taskId: 'crash-task',
    })
    await seed.putTask({
      taskId: 'crash-task',
      workflowId: 'workflows/b.workflow.ts',
      status: 'running',
      childRunId: 'crash-child',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    seed.close()

    // Reopen the same on-disk store under a fresh gateway; boot reconciliation
    // must not lose the task — it transitions to completed.
    const reopened = new SqliteRunStore({ path: dbPath })
    const { gw, base } = await bootGateway({ store: reopened as unknown as MemoryRunStore })
    try {
      const res = await fetch(`${base}/v1/tasks/crash-task`)
      expect(res.status).toBe(200)
      const task = await res.json()
      expect(task.status).toBe('completed')
      expect(task.completedAt).toBeTruthy()
    } finally {
      await gw.stop()
    }
  })
})
