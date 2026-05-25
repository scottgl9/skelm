import { describe, expect, it } from 'vitest'

import { defineConfig } from '../src/config.js'

describe('SkelmConfig entrypoint', () => {
  it('defineConfig preserves the entrypoint field', () => {
    const config = defineConfig({ entrypoint: './builder.workflow.mts' })
    expect(config.entrypoint).toBe('./builder.workflow.mts')
  })

  it('entrypoint is optional', () => {
    const config = defineConfig({})
    expect(config.entrypoint).toBeUndefined()
  })
})
