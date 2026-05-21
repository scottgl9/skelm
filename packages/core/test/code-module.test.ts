import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { code, pipeline } from '../src/builders.js'
import { runPipeline } from '../src/runner.js'

const FIXTURES_DIR = resolve(fileURLToPath(new URL('./fixtures', import.meta.url)))

describe('code() — external module', () => {
  it('loads the default export and runs it', async () => {
    const wf = pipeline({
      id: 'wf-default',
      baseDir: FIXTURES_DIR,
      steps: [code({ id: 'load', module: './code-module-default.ts' })],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(run.steps[0]?.output).toEqual({ value: 'from-default' })
  })

  it('loads a named export when "export" is set', async () => {
    const wf = pipeline({
      id: 'wf-named',
      baseDir: FIXTURES_DIR,
      steps: [code({ id: 'load', module: './code-module-named.ts', export: 'handler' })],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('completed')
    expect(run.steps[0]?.output).toEqual({ value: 'from-named' })
  })

  it('rejects when both run and module are supplied', () => {
    expect(() =>
      code({
        id: 'both',
        run: () => undefined,
        module: './code-module-default.ts',
      }),
    ).toThrow(/exactly one of "run" or "module"/)
  })

  it('rejects when neither run nor module is supplied', () => {
    expect(() => code({ id: 'neither' })).toThrow(/exactly one of "run" or "module"/)
  })

  it('rejects "export" without "module"', () => {
    expect(() => code({ id: 'lonely-export', run: () => undefined, export: 'handler' })).toThrow(
      /"export" only applies when "module" is set/,
    )
  })

  it('errors when the module path does not exist', async () => {
    const wf = pipeline({
      id: 'wf-missing',
      baseDir: FIXTURES_DIR,
      steps: [code({ id: 'load', module: './does-not-exist.ts' })],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.message).toMatch(/module not found/)
  })

  it('errors when the named export is not a function', async () => {
    const wf = pipeline({
      id: 'wf-bad-export',
      baseDir: FIXTURES_DIR,
      steps: [
        code({
          id: 'load',
          module: './code-module-named.ts',
          export: 'missing',
        }),
      ],
    })
    const run = await runPipeline(wf, undefined)
    expect(run.status).toBe('failed')
    expect(run.error?.message).toMatch(/is not a function/)
  })
})
