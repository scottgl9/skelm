import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSkelmConfig } from '../src/load-config.js'

function writeConfigIn(dir: string, filename: string, body: string): string {
  const path = join(dir, filename)
  writeFileSync(path, body)
  return path
}

describe('workflow config filename resolution', () => {
  it('finds skelm.config.mjs when present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-wf-cfg-'))
    writeConfigIn(dir, 'skelm.config.mjs', 'export default { env: { FROM: "config" } }')
    const { config, source } = await loadSkelmConfig({ fromDir: dir })
    expect(config.env?.FROM).toBe('config')
    expect(source).toContain('skelm.config.mjs')
  })

  it('finds skelm.config.ts when present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-wf-cfg-'))
    writeConfigIn(dir, 'skelm.config.mjs', 'export default { env: { FROM: "config" } }')
    const { config, source } = await loadSkelmConfig({ fromDir: dir })
    expect(config.env?.FROM).toBe('config')
    expect(source).toContain('skelm.config')
  })

  it('returns default config when no skelm.config.* is present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-wf-cfg-'))
    const { source } = await loadSkelmConfig({ fromDir: dir })
    expect(source).toBeNull()
  })
})
