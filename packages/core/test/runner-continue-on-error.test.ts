import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../src/builders.js'
import { RunCancelledError } from '../src/errors.js'
import { runPipeline } from '../src/runner.js'

describe('runPipeline — continueOnError', () => {
  it('continues to the next step when a continueOnError step throws', async () => {
    const ran: string[] = []
    const wf = pipeline({
      id: 'soft-fail',
      steps: [
        code({
          id: 'a',
          run: () => {
            ran.push('a')
            return 1
          },
        }),
        code({
          id: 'b',
          continueOnError: true,
          run: () => {
            ran.push('b')
            throw new Error('boom')
          },
        }),
        code({
          id: 'c',
          run: () => {
            ran.push('c')
            return 3
          },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)

    expect(ran).toEqual(['a', 'b', 'c'])
    expect(run.steps.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(run.steps.map((s) => s.status)).toEqual(['completed', 'failed', 'completed'])
    expect(run.status).toBe('failed')
    expect(run.error).toBeDefined()
    expect(run.error?.message).toBe('boom')
  })

  it('still breaks when continueOnError is not set (regression guard)', async () => {
    const ran: string[] = []
    const wf = pipeline({
      id: 'hard-fail',
      steps: [
        code({
          id: 'a',
          run: () => {
            ran.push('a')
            return 1
          },
        }),
        code({
          id: 'b',
          run: () => {
            ran.push('b')
            throw new Error('boom')
          },
        }),
        code({
          id: 'c',
          run: () => {
            ran.push('c')
            return 3
          },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)

    expect(ran).toEqual(['a', 'b'])
    expect(run.steps.map((s) => s.id)).toEqual(['a', 'b'])
    expect(run.status).toBe('failed')
  })

  it('RunCancelledError always aborts, even with continueOnError: true', async () => {
    const ran: string[] = []
    const wf = pipeline({
      id: 'cancelled',
      steps: [
        code({
          id: 'a',
          run: () => {
            ran.push('a')
            return 1
          },
        }),
        code({
          id: 'b',
          continueOnError: true,
          run: () => {
            ran.push('b')
            throw new RunCancelledError('test cancel')
          },
        }),
        code({
          id: 'c',
          run: () => {
            ran.push('c')
            return 3
          },
        }),
      ],
    })

    const run = await runPipeline(wf, undefined)

    expect(ran).toEqual(['a', 'b'])
    expect(run.status).toBe('cancelled')
  })
})
