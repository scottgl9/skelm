import { describe, expect, it } from 'vitest'
import { code, invoke, pipeline } from '../src/builders.js'
import { InvokePipelineNotFoundError } from '../src/errors.js'
import { runPipeline } from '../src/runner.js'

describe('invoke() step', () => {
  it('resolves a registered pipeline and returns its output', async () => {
    const nested = pipeline<{ value: number }, { doubled: number }>({
      id: 'double',
      steps: [
        code({
          id: 'doubler',
          run: (ctx) => ({ doubled: (ctx.input as { value: number }).value * 2 }),
        }),
      ],
    })

    const registry: Record<string, typeof nested> = { double: nested }
    const pipelineRegistry = (id: string) => registry[id]

    const wf = pipeline<{ value: number }, { doubled: number }>({
      id: 'main',
      steps: [
        invoke<{ doubled: number }>({
          id: 'invoke-double',
          pipelineId: 'double',
        }),
      ],
    })

    const run = await runPipeline(wf, { value: 21 }, { pipelineRegistry })

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ doubled: 42 })
    expect(run.steps[0]?.status).toBe('completed')
    expect((run.steps[0]?.output as { doubled: number }).doubled).toBe(42)
  })

  it('passes the current pipeline input by default', async () => {
    const nested = pipeline<{ name: string }, { greeting: string }>({
      id: 'greet',
      steps: [
        code({
          id: 'say-hi',
          run: (ctx) => ({ greeting: `hello, ${(ctx.input as { name: string }).name}` }),
        }),
      ],
    })

    const registry: Record<string, typeof nested> = { greet: nested }
    const pipelineRegistry = (id: string) => registry[id]

    const wf = pipeline<{ name: string }, { greeting: string }>({
      id: 'main',
      steps: [
        invoke<{ greeting: string }>({
          id: 'invoke-greet',
          pipelineId: 'greet',
        }),
      ],
    })

    const run = await runPipeline(wf, { name: 'world' }, { pipelineRegistry })

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ greeting: 'hello, world' })
  })

  it('passes computed input via the input function', async () => {
    const nested = pipeline<{ value: number }, { result: number }>({
      id: 'triple',
      steps: [
        code({
          id: 'tripler',
          run: (ctx) => ({ result: (ctx.input as { value: number }).value * 3 }),
        }),
      ],
    })

    const registry: Record<string, typeof nested> = { triple: nested }
    const pipelineRegistry = (id: string) => registry[id]

    const wf = pipeline<{ base: number }, { result: number }>({
      id: 'main',
      steps: [
        code({
          id: 'prepare',
          run: (ctx) => ({ computed: (ctx.input as { base: number }).base + 10 }),
        }),
        invoke<{ result: number }>({
          id: 'invoke-triple',
          pipelineId: 'triple',
          input: (ctx) => ({ value: (ctx.steps.prepare as { computed: number }).computed }),
        }),
      ],
    })

    const run = await runPipeline(wf, { base: 5 }, { pipelineRegistry })

    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ result: 45 }) // (5 + 10) * 3 = 45
  })

  it('throws InvokePipelineNotFoundError when the registry returns undefined', async () => {
    const wf = pipeline({
      id: 'main',
      steps: [
        invoke({
          id: 'invoke-missing',
          pipelineId: 'nonexistent',
        }),
      ],
    })

    const pipelineRegistry = () => undefined

    const run = await runPipeline(wf, {}, { pipelineRegistry })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('InvokePipelineNotFoundError')
    expect(run.error?.message).toContain('nonexistent')
  })

  it('throws InvokePipelineNotFoundError with correct stepId and pipelineId', async () => {
    const wf = pipeline({
      id: 'main',
      steps: [
        invoke({
          id: 'my-invoke-step',
          pipelineId: 'missing-pipeline',
        }),
      ],
    })

    const pipelineRegistry = () => undefined

    const run = await runPipeline(wf, {}, { pipelineRegistry })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('InvokePipelineNotFoundError')
    expect(run.error?.message).toContain('invoke(my-invoke-step)')
    expect(run.error?.message).toContain('missing-pipeline')
  })

  it('propagates nested pipeline failure as a step error', async () => {
    const nested = pipeline({
      id: 'failing',
      steps: [
        code({
          id: 'boom',
          run: () => {
            throw new Error('nested failure')
          },
        }),
      ],
    })

    const registry: Record<string, typeof nested> = { failing: nested }
    const pipelineRegistry = (id: string) => registry[id]

    const wf = pipeline({
      id: 'main',
      steps: [
        invoke({
          id: 'invoke-fail',
          pipelineId: 'failing',
        }),
      ],
    })

    const run = await runPipeline(wf, {}, { pipelineRegistry })

    expect(run.status).toBe('failed')
    expect(run.steps[0]?.status).toBe('failed')
    expect(run.steps[0]?.error?.message).toContain('nested failure')
  })
})
