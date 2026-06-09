import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadGatewayConfig } from '../src/load-config.js'

function writeConfig(dir: string, filename: string, body: string): string {
  const path = join(dir, filename)
  writeFileSync(path, body)
  return path
}

// Use '' as the "absent" sentinel — loadGatewayConfig already skips empty strings,
// and '' is safe to assign to process.env without Biome/Node converting it to "undefined".
function clearEnv(key: string): void {
  process.env[key] = ''
}

describe('loadGatewayConfig', () => {
  describe('explicit fromPath', () => {
    it('loads the file at the given path', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-cfg-'))
      const path = writeConfig(
        dir,
        'skelm.gateway.mjs',
        'export default { env: { FROM: "explicit" } }',
      )
      const { config, source } = await loadGatewayConfig({ fromPath: path })
      expect(config.env?.FROM).toBe('explicit')
      expect(source).toBe(path)
    })

    it('throws when the explicit path does not exist', async () => {
      await expect(
        loadGatewayConfig({ fromPath: '/tmp/__nonexistent_skelm_gateway_cfg__.ts' }),
      ).rejects.toThrow('gateway config file not found')
    })
  })

  describe('SKELM_GATEWAY_CONFIG env var', () => {
    let savedEnv: string | undefined

    beforeEach(() => {
      savedEnv = process.env.SKELM_GATEWAY_CONFIG
    })

    afterEach(() => {
      process.env.SKELM_GATEWAY_CONFIG = savedEnv ?? ''
    })

    it('loads from SKELM_GATEWAY_CONFIG when set', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-cfg-'))
      const path = writeConfig(
        dir,
        'skelm.gateway.mjs',
        'export default { env: { FROM: "env-var" } }',
      )
      process.env.SKELM_GATEWAY_CONFIG = path
      const { config, source } = await loadGatewayConfig()
      expect(config.env?.FROM).toBe('env-var')
      expect(source).toBe(path)
    })

    it('throws when SKELM_GATEWAY_CONFIG is set but the path does not exist', async () => {
      process.env.SKELM_GATEWAY_CONFIG = '/tmp/__nonexistent__.ts'
      await expect(loadGatewayConfig()).rejects.toThrow('SKELM_GATEWAY_CONFIG path not found')
    })

    it('explicit fromPath takes precedence over SKELM_GATEWAY_CONFIG', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-cfg-'))
      const explicit = writeConfig(
        dir,
        'skelm.gateway.mjs',
        'export default { env: { FROM: "explicit" } }',
      )
      const envFile = writeConfig(dir, 'other.mjs', 'export default { env: { FROM: "env-var" } }')
      process.env.SKELM_GATEWAY_CONFIG = envFile
      const { config } = await loadGatewayConfig({ fromPath: explicit })
      expect(config.env?.FROM).toBe('explicit')
    })
  })

  describe('home directory lookup', () => {
    let savedHome: string | undefined
    let savedEnv: string | undefined

    beforeEach(() => {
      savedHome = process.env.HOME
      savedEnv = process.env.SKELM_GATEWAY_CONFIG
      clearEnv('SKELM_GATEWAY_CONFIG')
    })

    afterEach(() => {
      process.env.HOME = savedHome ?? ''
      process.env.SKELM_GATEWAY_CONFIG = savedEnv ?? ''
    })

    it('loads ~/.skelm/skelm.gateway.ts when present', async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'skelm-home-'))
      const skelmDir = join(fakeHome, '.skelm')
      mkdirSync(skelmDir)
      writeConfig(skelmDir, 'skelm.gateway.mjs', 'export default { env: { FROM: "home" } }')
      process.env.HOME = fakeHome
      const { config, source } = await loadGatewayConfig()
      expect(config.env?.FROM).toBe('home')
      expect(source).toContain('.skelm')
      expect(source).toContain('skelm.gateway.mjs')
    })
  })

  describe('cwd walkup fallback', () => {
    let savedEnv: string | undefined
    let savedCwd: string

    beforeEach(() => {
      savedEnv = process.env.SKELM_GATEWAY_CONFIG
      savedCwd = process.cwd()
      clearEnv('SKELM_GATEWAY_CONFIG')
    })

    afterEach(() => {
      process.env.SKELM_GATEWAY_CONFIG = savedEnv ?? ''
      process.chdir(savedCwd)
    })

    it('finds skelm.gateway.ts in cwd', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-cwd-'))
      writeConfig(dir, 'skelm.gateway.mjs', 'export default { env: { FROM: "cwd-gateway" } }')
      process.chdir(dir)
      const { config, source } = await loadGatewayConfig()
      expect(config.env?.FROM).toBe('cwd-gateway')
      expect(source).toContain('skelm.gateway.mjs')
    })

    it('falls back to skelm.config.ts in cwd (backwards compat)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-cwd-'))
      writeConfig(dir, 'skelm.config.mjs', 'export default { env: { FROM: "legacy-config" } }')
      process.chdir(dir)
      const { config, source } = await loadGatewayConfig()
      expect(config.env?.FROM).toBe('legacy-config')
      expect(source).toContain('skelm.config.mjs')
    })

    it('prefers skelm.gateway.ts over skelm.config.ts in the same directory', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-cwd-'))
      writeConfig(dir, 'skelm.gateway.mjs', 'export default { env: { FROM: "gateway" } }')
      writeConfig(dir, 'skelm.config.mjs', 'export default { env: { FROM: "legacy" } }')
      process.chdir(dir)
      const { config, source } = await loadGatewayConfig()
      expect(config.env?.FROM).toBe('gateway')
      expect(source).toContain('skelm.gateway.mjs')
    })
  })

  describe('default config fallback', () => {
    let savedEnv: string | undefined
    let savedCwd: string

    beforeEach(() => {
      savedEnv = process.env.SKELM_GATEWAY_CONFIG
      savedCwd = process.cwd()
      clearEnv('SKELM_GATEWAY_CONFIG')
    })

    afterEach(() => {
      process.env.SKELM_GATEWAY_CONFIG = savedEnv ?? ''
      process.chdir(savedCwd)
    })

    it('returns default config (source null) when no config file is found', async () => {
      // Use a temp dir with no config and chdir there so walk-up doesn't find repo config
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-empty-'))
      process.chdir(dir)
      const { source } = await loadGatewayConfig()
      expect(source).toBeNull()
    })
  })
})
