import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyEnvLayers } from '../src/load-config.js'

describe('applyEnvLayers — process.env > .env > config.env', () => {
  let dir: string
  const originalEnv = { ...process.env }
  const ownedKeys = ['SKELM_TEST_A', 'SKELM_TEST_B', 'SKELM_TEST_C', 'SKELM_TEST_D']

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skelm-env-'))
    for (const key of ownedKeys) {
      delete process.env[key]
    }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of ownedKeys) {
      const original = originalEnv[key]
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    }
  })

  it('applies config.env when no .env file and no process.env value', () => {
    const out = applyEnvLayers({ env: { SKELM_TEST_A: 'from-config' } }, dir)
    expect(process.env.SKELM_TEST_A).toBe('from-config')
    expect(out.env?.SKELM_TEST_A).toBe('from-config')
  })

  it('overrides config.env with .env file values', () => {
    writeFileSync(join(dir, '.env'), 'SKELM_TEST_A=from-dotenv\n')
    const out = applyEnvLayers({ env: { SKELM_TEST_A: 'from-config' } }, dir)
    expect(process.env.SKELM_TEST_A).toBe('from-dotenv')
    expect(out.env?.SKELM_TEST_A).toBe('from-dotenv')
  })

  it('keeps an existing process.env value, never overwriting it', () => {
    process.env.SKELM_TEST_A = 'from-process'
    writeFileSync(join(dir, '.env'), 'SKELM_TEST_A=from-dotenv\n')
    applyEnvLayers({ env: { SKELM_TEST_A: 'from-config' } }, dir)
    expect(process.env.SKELM_TEST_A).toBe('from-process')
  })

  it('parses quoted values, blank lines, comments, and export prefixes', () => {
    writeFileSync(
      join(dir, '.env'),
      [
        '# leading comment',
        '',
        'SKELM_TEST_A=plain',
        'SKELM_TEST_B="quoted with spaces"',
        "SKELM_TEST_C='single-quoted'",
        'export SKELM_TEST_D=exported # trailing comment',
        'bad-key=ignored',
      ].join('\n'),
    )
    applyEnvLayers({}, dir)
    expect(process.env.SKELM_TEST_A).toBe('plain')
    expect(process.env.SKELM_TEST_B).toBe('quoted with spaces')
    expect(process.env.SKELM_TEST_C).toBe('single-quoted')
    expect(process.env.SKELM_TEST_D).toBe('exported')
  })

  it('returns the merged env on the config for inspection', () => {
    writeFileSync(join(dir, '.env'), 'SKELM_TEST_B=from-dotenv\n')
    const out = applyEnvLayers(
      { env: { SKELM_TEST_A: 'from-config', SKELM_TEST_B: 'from-config' } },
      dir,
    )
    expect(out.env).toEqual({ SKELM_TEST_A: 'from-config', SKELM_TEST_B: 'from-dotenv' })
  })
})
