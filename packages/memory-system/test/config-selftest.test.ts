import { describe, expect, it } from 'vitest'
import { resolveMemorySystemConfig } from '../src/config.js'
import { runSelfTest } from '../src/self-test.js'

describe('config', () => {
  it('applies safe defaults', () => {
    const c = resolveMemorySystemConfig()
    expect(c.project).toBe('default')
    expect(c.recallLimit).toBe(200)
    expect(c.duplicateScore).toBeGreaterThan(0)
  })

  it('rejects unknown keys (strict)', () => {
    expect(() => resolveMemorySystemConfig({ nope: 1 } as never)).toThrow()
  })

  it('rejects out-of-range scores', () => {
    expect(() => resolveMemorySystemConfig({ promoteScore: 2 })).toThrow()
  })
})

describe('self-test', () => {
  it('runs a representative workflow against fakes without throwing', async () => {
    await expect(runSelfTest()).resolves.toBeUndefined()
  })
})
