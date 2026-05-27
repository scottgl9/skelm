import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSkelmConfig } from '../src/load-config.js'

// Guards the one fragile point in the chain skelm.config.ts -> running gateway:
// mergeWithDefaults() rebuilds the config explicitly, so a regression there
// could silently drop the `agentmemory` block. These assert it survives
// loading verbatim, and that omitting it leaves the integration disabled.

function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'skelm-am-config-'))
  const path = join(dir, 'skelm.config.mjs')
  writeFileSync(path, body)
  return path
}

describe('skelm.config.ts agentmemory block', () => {
  it('survives config loading verbatim', async () => {
    const path = writeConfig(
      `export default { agentmemory: { enabled: true, url: 'http://localhost:9999', secretName: 'AM_SECRET', timeoutMs: 1234 } }`,
    )
    const { config } = await loadSkelmConfig({ explicitPath: path })
    expect(config.agentmemory).toEqual({
      enabled: true,
      url: 'http://localhost:9999',
      secretName: 'AM_SECRET',
      timeoutMs: 1234,
    })
  })

  it('carries default permissions for agentmemory through to the resolved config', async () => {
    const path = writeConfig(
      'export default { agentmemory: { enabled: true }, defaults: { permissions: { agentmemory: { allowObserve: true, allowSearch: true } } } }',
    )
    const { config } = await loadSkelmConfig({ explicitPath: path })
    expect(config.defaults?.permissions?.agentmemory).toEqual({
      allowObserve: true,
      allowSearch: true,
    })
  })

  it('leaves agentmemory undefined (disabled) when the block is omitted', async () => {
    const path = writeConfig('export default { pipelines: {} }')
    const { config } = await loadSkelmConfig({ explicitPath: path })
    expect(config.agentmemory).toBeUndefined()
  })
})
