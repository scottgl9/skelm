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
  it('finds skelm.workflow.ts when present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-wf-cfg-'))
    writeConfigIn(dir, 'skelm.workflow.mjs', 'export default { env: { FROM: "workflow" } }')
    const { config, source } = await loadSkelmConfig({ fromDir: dir })
    expect(config.env?.FROM).toBe('workflow')
    expect(source).toContain('skelm.workflow.mjs')
  })

  it('prefers skelm.workflow.ts over skelm.config.ts in the same directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-wf-cfg-'))
    writeConfigIn(dir, 'skelm.workflow.mjs', 'export default { env: { FROM: "workflow" } }')
    writeConfigIn(dir, 'skelm.config.mjs', 'export default { env: { FROM: "legacy" } }')
    const { config, source } = await loadSkelmConfig({ fromDir: dir })
    expect(config.env?.FROM).toBe('workflow')
    expect(source).toContain('skelm.workflow.mjs')
  })

  it('falls back to skelm.config.ts when no skelm.workflow.ts exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-wf-cfg-'))
    writeConfigIn(dir, 'skelm.config.mjs', 'export default { env: { FROM: "legacy" } }')
    const { config, source } = await loadSkelmConfig({ fromDir: dir })
    expect(config.env?.FROM).toBe('legacy')
    expect(source).toContain('skelm.config.mjs')
  })

  it('returns default config when neither file is present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skelm-wf-cfg-'))
    const { source } = await loadSkelmConfig({ fromDir: dir })
    expect(source).toBeNull()
  })
})
