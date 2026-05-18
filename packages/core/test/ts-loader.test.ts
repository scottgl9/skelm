import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { clearTsModuleCache, loadTsModule, pickExport } from '../src/ts-loader.js'

const FIXTURES_DIR = resolve(fileURLToPath(new URL('./fixtures', import.meta.url)))

describe('ts-loader', () => {
  it('loads a relative .ts module with baseDir', async () => {
    clearTsModuleCache()
    const mod = await loadTsModule('./code-module-default.ts', { baseDir: FIXTURES_DIR })
    const def = pickExport(mod, 'default')
    expect(typeof def).toBe('function')
  })

  it('returns named exports', async () => {
    const mod = await loadTsModule('./code-module-named.ts', { baseDir: FIXTURES_DIR })
    const handler = pickExport(mod, 'handler')
    expect(typeof handler).toBe('function')
  })

  it('throws a clear error when the file does not exist', async () => {
    await expect(loadTsModule('./nope-not-here.ts', { baseDir: FIXTURES_DIR })).rejects.toThrow(
      /module not found/,
    )
  })

  it('unwraps the require(esm) double-default shape', () => {
    const fake = { default: { default: 42 } } as Record<string, unknown>
    expect(pickExport(fake, 'default')).toBe(42)
  })

  it('caches across calls (same promise reused)', async () => {
    clearTsModuleCache()
    const a = loadTsModule('./code-module-default.ts', { baseDir: FIXTURES_DIR })
    const b = loadTsModule('./code-module-default.ts', { baseDir: FIXTURES_DIR })
    expect(a).toBe(b)
    await a
  })
})
