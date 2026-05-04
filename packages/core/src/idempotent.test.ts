import { describe, expect, it } from 'vitest'
import { code, idempotent, pipeline } from './builders.js'
import { MemoryRunStore } from './run-store.js'
import { runPipeline } from './runner.js'

describe('idempotent()', () => {
  it('returns the cached output on repeated runs with the same key', async () => {
    const store = new MemoryRunStore()
    let executions = 0
    const wf = pipeline<{ messageId: string }, number>({
      id: 'idempotent-basic',
      steps: [
        idempotent<number>({
          key: (ctx) => ctx.input.messageId,
          step: code({
            id: 'process',
            run: () => {
              executions += 1
              return executions
            },
          }),
        }),
      ],
    })

    const first = await runPipeline(wf, { messageId: 'msg-1' }, { store })
    const second = await runPipeline(wf, { messageId: 'msg-1' }, { store })
    const third = await runPipeline(wf, { messageId: 'msg-2' }, { store })

    expect(first.output).toBe(1)
    expect(second.output).toBe(1)
    expect(third.output).toBe(2)
    expect(executions).toBe(2)
  })

  it('can share idempotency state across pipelines via a named scope', async () => {
    const store = new MemoryRunStore()
    let executions = 0

    const build = (id: string) =>
      pipeline<{ messageId: string }, string>({
        id,
        steps: [
          idempotent<string>({
            key: (ctx) => ctx.input.messageId,
            state: { scope: 'pipeline+name', name: 'shared-idempotent' },
            step: code({
              id: 'process',
              run: () => {
                executions += 1
                return `run-${executions}`
              },
            }),
          }),
        ],
      })

    const first = await runPipeline(build('pipe-a'), { messageId: 'msg-1' }, { store })
    const second = await runPipeline(build('pipe-b'), { messageId: 'msg-1' }, { store })

    expect(first.output).toBe('run-1')
    expect(second.output).toBe('run-1')
    expect(executions).toBe(1)
  })

  it('explicit id: outer id used for ctx.steps access', async () => {
    const wf = pipeline<{ x: number }, { result: number }>({
      id: 'idempotent-explicit-id',
      steps: [
        idempotent<{ doubled: number }>({
          id: 'outer-id',
          key: (ctx) => `key-${ctx.input.x}`,
          step: code({
            id: 'inner-id',
            run: (ctx) => ({ doubled: ctx.input.x * 2 }),
          }),
        }),
        code({
          id: 'read',
          run: (ctx) =>
            // Result accessible under outer id, not inner id
            ({ result: (ctx.steps['outer-id'] as { doubled: number }).doubled }),
        }),
      ],
    })
    const r = await runPipeline(wf, { x: 7 })
    expect(r.output?.result).toBe(14)
    // inner-id should NOT be in ctx.steps at the collect step
    // (only outer-id is, because that is what the pipeline stores)
    expect((r.steps ?? []).map((s) => s.id)).not.toContain('inner-id')
    expect((r.steps ?? []).map((s) => s.id)).toContain('outer-id')
  })

  it('backward-compat: omitting id falls back to inner step id', async () => {
    const wf = pipeline<{ x: number }, number>({
      id: 'idempotent-compat',
      steps: [
        idempotent<number>({
          key: () => 'k',
          step: code({ id: 'the-step', run: (ctx) => ctx.input.x as number }),
        }),
      ],
    })
    const result = await runPipeline(wf, { x: 42 })
    expect(result.output).toBe(42)
  })
})
