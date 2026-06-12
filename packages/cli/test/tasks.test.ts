import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { code, pipeline } from '@skelm/core'
import { Gateway } from '@skelm/gateway'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/exit-codes.js'
import { main } from '../src/main.js'

let stateDir: string
let projectRoot: string
let priorStateDir: string | undefined
let priorNoAutostart: string | undefined

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'skelm-cli-tasks-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'skelm-cli-tasks-root-'))
  priorStateDir = process.env.SKELM_STATE_DIR
  priorNoAutostart = process.env.SKELM_NO_AUTOSTART
  process.env.SKELM_STATE_DIR = stateDir
  process.env.SKELM_NO_AUTOSTART = '1'
})

afterEach(async () => {
  if (priorStateDir === undefined) process.env.SKELM_STATE_DIR = undefined
  else process.env.SKELM_STATE_DIR = priorStateDir
  if (priorNoAutostart === undefined) process.env.SKELM_NO_AUTOSTART = undefined
  else process.env.SKELM_NO_AUTOSTART = priorNoAutostart
  await removeTreeWithRetry(stateDir)
  await removeTreeWithRetry(projectRoot)
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
        await new Promise((r) => setTimeout(r, 80))
        return { done: true }
      },
    }),
  ],
})

async function removeTreeWithRetry(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      if (
        attempt >= 4 ||
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOTEMPTY'
      ) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
}

describe('skelm tasks — CLI smoke', () => {
  it('errors out with usage when invoked without a subcommand', async () => {
    const { stderr, exitCode } = await invoke(['tasks'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toContain('tasks requires')
  })

  it('errors out when the gateway is not running', async () => {
    const { stderr, exitCode } = await invoke(['tasks', 'list'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toContain('gateway is not running')
  })

  it('get without a task id exits CLI_ERROR', async () => {
    const gw = await startGatewayOnFreePort()
    try {
      const { stderr, exitCode } = await invoke(['tasks', 'get'])
      expect(exitCode).toBe(EXIT.CLI_ERROR)
      expect(stderr).toContain('requires a task id')
    } finally {
      await gw.stop()
    }
  })

  it('list shows an empty table, then a created task', async () => {
    const gw = await startGatewayOnFreePort()
    try {
      const empty = await invoke(['tasks', 'list'])
      expect(empty.exitCode).toBe(EXIT.OK)
      expect(empty.stdout).toContain('No tasks found.')

      const taskId = await createTask(gw)

      const list = await invoke(['tasks', 'list'])
      expect(list.exitCode).toBe(EXIT.OK)
      expect(list.stdout).toContain(taskId)

      const jsonList = await invoke(['tasks', 'list', '--json'])
      expect(jsonList.exitCode).toBe(EXIT.OK)
      const tasks = JSON.parse(jsonList.stdout) as Array<{ taskId: string }>
      expect(tasks.some((t) => t.taskId === taskId)).toBe(true)
    } finally {
      await gw.stop()
    }
  })

  it('get returns one task, and CLI_ERROR for an unknown id', async () => {
    const gw = await startGatewayOnFreePort()
    try {
      const taskId = await createTask(gw)
      const get = await invoke(['tasks', 'get', taskId, '--json'])
      expect(get.exitCode).toBe(EXIT.OK)
      expect((JSON.parse(get.stdout) as { taskId: string }).taskId).toBe(taskId)

      const missing = await invoke(['tasks', 'get', 'task_nope'])
      expect(missing.exitCode).toBe(EXIT.CLI_ERROR)
      expect(missing.stderr).toContain('task not found')
    } finally {
      await gw.stop()
    }
  })

  it('cancel a running task then retry it', async () => {
    const gw = await startGatewayOnFreePort()
    try {
      // A slow workflow stays running long enough to cancel deterministically.
      const taskId = await createTask(gw, 'workflows/slow.workflow.ts')

      const cancel = await invoke(['tasks', 'cancel', taskId, '--json'])
      expect(cancel.exitCode).toBe(EXIT.OK)
      expect((JSON.parse(cancel.stdout) as { status: string }).status).toBe('cancelled')

      const retry = await invoke(['tasks', 'retry', taskId, '--json'])
      expect(retry.exitCode).toBe(EXIT.OK)
      const retried = JSON.parse(retry.stdout) as { taskId: string; retryOfTaskId?: string }
      expect(retried.taskId).not.toBe(taskId)
      expect(retried.retryOfTaskId).toBe(taskId)
    } finally {
      await gw.stop()
    }
  })

  it('cancel on a completed task is a conflict (CLI_ERROR)', async () => {
    const gw = await startGatewayOnFreePort()
    try {
      const taskId = await createTask(gw)
      await waitFor(async () => {
        const t = await gw.runStore.getTask(taskId)
        return t?.status === 'completed'
      })
      const cancel = await invoke(['tasks', 'cancel', taskId])
      expect(cancel.exitCode).toBe(EXIT.CLI_ERROR)
    } finally {
      await gw.stop()
    }
  })
})

describe('skelm lineage — CLI smoke', () => {
  it('errors without a run id', async () => {
    const { stderr, exitCode } = await invoke(['lineage'])
    expect(exitCode).toBe(EXIT.CLI_ERROR)
    expect(stderr).toContain('requires a run id')
  })

  it('returns CLI_ERROR for an unknown run', async () => {
    const gw = await startGatewayOnFreePort()
    try {
      const res = await invoke(['lineage', 'nope'])
      expect(res.exitCode).toBe(EXIT.CLI_ERROR)
      expect(res.stderr).toContain('run not found')
    } finally {
      await gw.stop()
    }
  })

  it('emits the lineage tree as JSON for a known run', async () => {
    const gw = await startGatewayOnFreePort()
    try {
      const taskId = await createTask(gw)
      const childRunId = await waitFor(async () => {
        const t = await gw.runStore.getTask(taskId)
        return t?.childRunId
      })
      const res = await invoke(['lineage', childRunId, '--json'])
      expect(res.exitCode).toBe(EXIT.OK)
      const lineage = JSON.parse(res.stdout) as { runId: string }
      expect(lineage.runId).toBe(childRunId)
    } finally {
      await gw.stop()
    }
  })
})

async function createTask(gw: Gateway, workflowId = 'workflows/b.workflow.ts'): Promise<string> {
  const task = await gw.tasks.createTask({ workflowId })
  return task.taskId
}

async function waitFor<T>(
  predicate: () => Promise<T | undefined | null | false>,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await predicate()
    if (v !== undefined && v !== null && v !== false) return v
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('waitFor: timed out')
}

interface InvokeResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function invoke(argv: readonly string[]): Promise<InvokeResult> {
  let stdout = ''
  let stderr = ''
  const result = await main(argv, {
    stdout: makeWritable((s) => {
      stdout += s
    }),
    stderr: makeWritable((s) => {
      stderr += s
    }),
    stdin: Readable.from([]),
  })
  return { stdout, stderr, exitCode: result.exitCode }
}

function makeWritable(append: (s: string) => void): Writable {
  return new Writable({
    write(chunk, _enc, cb) {
      append(chunk.toString())
      cb()
    },
  })
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close()
        reject(new Error('port pick failed'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}

async function startGatewayOnFreePort(): Promise<Gateway> {
  await fs.mkdir(join(projectRoot, 'workflows'), { recursive: true })
  await fs.writeFile(join(projectRoot, 'workflows/b.workflow.ts'), 'export default {}')
  await fs.writeFile(join(projectRoot, 'workflows/slow.workflow.ts'), 'export default {}')
  const MAX_ATTEMPTS = 6
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const port = await pickFreePort()
    const gw = new Gateway({
      stateDir,
      projectRoot,
      watchRegistries: false,
      enableHttp: true,
      httpPort: port,
      url: `http://127.0.0.1:${port}`,
      loadWorkflow: async (id: string) => (id.includes('slow') ? slowWf : wf),
      config: { registries: { workflows: { glob: 'workflows/**/*.workflow.{mts,ts}' } } },
    })
    try {
      await gw.start()
      return gw
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'EADDRINUSE') throw err
      await gw.stop().catch(() => {})
    }
  }
  throw lastErr ?? new Error(`could not bind a free port after ${MAX_ATTEMPTS} attempts`)
}
