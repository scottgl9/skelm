import { describe, expect, it } from 'vitest'
import { MemoryRunStore, code, pipeline, runPipeline } from '../src/index.js'

// Pre-fix, the Run record was only persisted after every event finished
// writing. A crash mid-step left events orphaned (no Run row) and broke
// `listRuns({status:'running'})` as a recovery seed.

describe('runner — crash atomicity', () => {
  it('persists a `running` Run record before the first step executes', async () => {
    const store = new MemoryRunStore()
    let observed: Awaited<ReturnType<typeof store.getRun>> = null

    const observeStep = code({
      id: 'observe',
      async run(ctx) {
        observed = await store.getRun(ctx.run.runId)
        return { ok: true }
      },
    })

    const wf = pipeline({ id: 'atomicity', steps: [observeStep] })
    const run = await runPipeline(wf, undefined, { store })

    expect(run.status).toBe('completed')
    expect(observed).not.toBeNull()
    expect(observed?.status).toBe('running')
    expect(observed?.pipelineId).toBe('atomicity')
  })

  it('listRuns({status:"running"}) surfaces in-flight runs as a recovery seed', async () => {
    const store = new MemoryRunStore()
    const seen: string[] = []

    const inspectStep = code({
      id: 'inspect',
      async run() {
        for await (const summary of store.listRuns({ status: 'running' })) {
          seen.push(summary.runId)
        }
        return { ok: true }
      },
    })

    const wf = pipeline({ id: 'recovery-seed', steps: [inspectStep] })
    const run = await runPipeline(wf, undefined, { store })

    expect(run.status).toBe('completed')
    expect(seen).toContain(run.runId)
  })

  it('finalizes the Run record to a terminal status after completion', async () => {
    const store = new MemoryRunStore()
    const wf = pipeline({
      id: 'finalize',
      steps: [
        code({
          id: 's',
          async run() {
            return { ok: true }
          },
        }),
      ],
    })
    const run = await runPipeline(wf, undefined, { store })
    const persisted = await store.getRun(run.runId)
    expect(persisted?.status).toBe('completed')
  })
})
