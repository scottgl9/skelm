import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { code, pipeline } from './builders.js'
import { runPipeline } from './runner.js'
import { SchemaValidationError, validate } from './schema.js'

describe('validate()', () => {
  const Person = z.object({ name: z.string(), age: z.number().int().nonnegative() })

  it('returns the parsed value on success', async () => {
    const value = await validate(Person, { name: 'a', age: 1 }, 'input')
    expect(value).toEqual({ name: 'a', age: 1 })
  })

  it('throws SchemaValidationError with issues on failure', async () => {
    await expect(() => validate(Person, { name: 1, age: -1 }, 'input')).rejects.toBeInstanceOf(
      SchemaValidationError,
    )
  })

  it('the error names the boundary (input | output)', async () => {
    try {
      await validate(Person, {}, 'output')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError)
      expect((err as SchemaValidationError).where).toBe('output')
      expect((err as SchemaValidationError).message).toMatch(/output validation failed/)
    }
  })
})

describe('runPipeline — schema validation', () => {
  it('validates input on run start; bad input fails the run', async () => {
    const wf = pipeline({
      id: 'with-input',
      input: z.object({ n: z.number() }),
      steps: [code({ id: 'echo', run: () => ({}) })],
    })

    const run = await runPipeline(wf, { n: 'not a number' })
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('SchemaValidationError')
    expect(run.steps).toHaveLength(0)
  })

  it('validates output after finalize; bad output fails the run', async () => {
    const wf = pipeline<unknown, { greeting: string }>({
      id: 'bad-output',
      output: z.object({ greeting: z.string() }),
      steps: [
        code({
          id: 'noop',
          run: () => ({}),
        }),
      ],
      // biome-ignore lint/suspicious/noExplicitAny: deliberate bad output for the test
      finalize: () => ({ greeting: 42 }) as any,
    })

    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.name).toBe('SchemaValidationError')
  })

  it('passes the parsed input forward to steps', async () => {
    const wf = pipeline({
      id: 'parsed',
      // Coerce a numeric string to a number on input.
      input: z.object({ n: z.coerce.number() }),
      steps: [
        code({ id: 'read', run: (ctx) => ({ doubled: (ctx.input as { n: number }).n * 2 }) }),
      ],
    })

    const run = await runPipeline(wf, { n: '7' })
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ doubled: 14 })
  })

  it('runs without schemas (schemas are optional)', async () => {
    const wf = pipeline({
      id: 'no-schema',
      steps: [code({ id: 'noop', run: () => ({ ok: true }) })],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(run.output).toEqual({ ok: true })
  })
})
