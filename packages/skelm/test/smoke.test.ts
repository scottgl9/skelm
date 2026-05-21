import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The `skelm` meta-package re-exports @skelm/core and ships the `skelm`
// bin that proxies to @skelm/cli. Without smoke coverage a broken
// re-export or a bin-shim regression shipped silently to users.

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))

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
