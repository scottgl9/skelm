import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The `skelm` meta-package re-exports @skelm/core and ships the `skelm`
// bin that proxies to @skelm/cli. Without smoke coverage a broken
// re-export or a bin-shim regression shipped silently to users.

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url))

describe('skelm meta-package', () => {
  it('public re-exports include core symbols (pipeline, code, runPipeline, EventBus)', async () => {
    // Dynamic import so the test doesn't statically depend on the
    // re-export path resolving at compile-time of the test file.
    const mod = (await import('../src/index.js')) as Record<string, unknown>
    expect(typeof mod.pipeline).toBe('function')
    expect(typeof mod.code).toBe('function')
    expect(typeof mod.runPipeline).toBe('function')
    expect(typeof mod.EventBus).toBe('function')
  })

  it('exports the documented skelm/plugin authoring surface', async () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      exports?: Record<string, unknown>
    }
    expect(pkg.exports?.['./plugin']).toEqual({
      types: './dist/plugin.d.ts',
      default: './dist/plugin.js',
    })

    const plugin = await import('../src/plugin.js')
    const defined = plugin.definePlugin({ id: 'test-plugin', version: '0.1.0' })
    expect(defined).toEqual({ id: 'test-plugin', version: '0.1.0' })
  })

  it('the skelm bin exits 0 on --help and prints usage', () => {
    const r = spawnSync(process.execPath, [BIN, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    expect(r.status).toBe(0)
    // Help text shape is defined by @skelm/cli; assert on the presence
    // of the top-level usage banner rather than full snapshot matching.
    expect(r.stdout).toMatch(/skelm|usage/i)
  })

  it('the skelm bin exits 0 on --version and prints a semver', () => {
    const r = spawnSync(process.execPath, [BIN, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/\d+\.\d+\.\d+/)
  })
})
