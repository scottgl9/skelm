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
})
