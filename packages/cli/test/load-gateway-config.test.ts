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

  describe('dual-load: skelm.gateway.* + co-located skelm.config.*', () => {
    let savedCwd: string
    let savedEnv: string | undefined

    beforeEach(() => {
      savedCwd = process.cwd()
      savedEnv = process.env.SKELM_GATEWAY_CONFIG
      clearEnv('SKELM_GATEWAY_CONFIG')
    })

    afterEach(() => {
      process.env.SKELM_GATEWAY_CONFIG = savedEnv ?? ''
      process.chdir(savedCwd)
    })

    it('merges instances from skelm.config.* when skelm.gateway.* is found in cwd', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-dual-'))
      writeConfig(
        dir,
        'skelm.gateway.mjs',
        `
        export default { server: { port: 9999 } }
      `,
      )
      writeConfig(
        dir,
        'skelm.config.mjs',
        `
        const fakeBackend = { id: 'my-backend', infer: async () => ({}) }
        export default { instances: [fakeBackend] }
      `,
      )
      process.chdir(dir)
      const { config, source } = await loadGatewayConfig()
      // Source is the gateway file
      expect(source).toContain('skelm.gateway.mjs')
      // Server config from gateway file
      expect(config.server?.port).toBe(9999)
      // instances from workflow config
      expect(config.instances).toHaveLength(1)
      expect(config.instances?.[0]?.id).toBe('my-backend')
    })

    it('merges instances from skelm.config.* when using explicit --gateway-config path', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-dual-explicit-'))
      const gatewayPath = writeConfig(
        dir,
        'skelm.gateway.mjs',
        `
        export default { server: { port: 8888 } }
      `,
      )
      writeConfig(
        dir,
        'skelm.config.mjs',
        `
        const fakeBackend = { id: 'explicit-backend', infer: async () => ({}) }
        export default { instances: [fakeBackend] }
      `,
      )
      const { config, source } = await loadGatewayConfig({ fromPath: gatewayPath })
      expect(source).toBe(gatewayPath)
      expect(config.server?.port).toBe(8888)
      expect(config.instances).toHaveLength(1)
      expect(config.instances?.[0]?.id).toBe('explicit-backend')
    })

    it('gateway instances win over workflow instances with the same id', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-dual-dedup-'))
      writeConfig(
        dir,
        'skelm.gateway.mjs',
        `
        const gw = { id: 'shared-id', source: 'gateway' }
        export default { instances: [gw] }
      `,
      )
      writeConfig(
        dir,
        'skelm.config.mjs',
        `
        const wf = { id: 'shared-id', source: 'workflow' }
        export default { instances: [wf] }
      `,
      )
      process.chdir(dir)
      const { config } = await loadGatewayConfig()
      expect(config.instances).toHaveLength(1)
      expect((config.instances?.[0] as Record<string, unknown>)?.source).toBe('gateway')
    })

    it('workflow env vars are merged into the returned config env', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-dual-env-'))
      writeConfig(
        dir,
        'skelm.gateway.mjs',
        `
        export default { env: { FROM_GATEWAY: 'yes' } }
      `,
      )
      writeConfig(
        dir,
        'skelm.config.mjs',
        `
        export default { env: { FROM_WORKFLOW: 'yes' } }
      `,
      )
      process.chdir(dir)
      const { config } = await loadGatewayConfig()
      expect(config.env?.FROM_GATEWAY).toBe('yes')
      expect(config.env?.FROM_WORKFLOW).toBe('yes')
    })

    it('does not attempt dual-load for legacy skelm.config.* fallback', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-legacy-'))
      // Only skelm.config.mjs (no skelm.gateway.mjs) — legacy path
      writeConfig(
        dir,
        'skelm.config.mjs',
        `
        export default { env: { FROM: 'legacy', server: { port: 7777 } } }
      `,
      )
      process.chdir(dir)
      const { config, source } = await loadGatewayConfig()
      expect(source).toContain('skelm.config.mjs')
      // No double-load — env is read once
      expect(config.env?.FROM).toBe('legacy')
    })

    it('does not lift workflow defaults.permissions into the gateway-global defaults', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-dual-perms-'))
      // Gateway omits permissions; workflow sets a project-level ceiling (networkEgress allow).
      writeConfig(dir, 'skelm.gateway.mjs', 'export default { server: { port: 3333 } }')
      writeConfig(
        dir,
        'skelm.config.mjs',
        `export default { defaults: { permissions: { networkEgress: 'allow' } } }`,
      )
      process.chdir(dir)
      const { config, hasExplicitDefaultPermissions } = await loadGatewayConfig()
      // Workflow's networkEgress:'allow' must not appear in the operator-global defaults.
      // (Framework deny-all from DEFAULT_CONFIG may still be present; we check the
      // workflow-specific 'allow' grant is not present.)
      expect(config.defaults?.permissions?.networkEgress).not.toBe('allow')
      // Gateway did not explicitly set permissions, so hasExplicitDefaultPermissions is false.
      expect(hasExplicitDefaultPermissions).toBe(false)
    })

    it('does not lift workflow defaults.permissionProfiles into the gateway-global defaults', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-dual-profiles-'))
      writeConfig(dir, 'skelm.gateway.mjs', 'export default { server: { port: 4444 } }')
      writeConfig(
        dir,
        'skelm.config.mjs',
        `export default { defaults: { permissionProfiles: { analyst: { networkEgress: 'allow' } } } }`,
      )
      process.chdir(dir)
      const { config, hasExplicitPermissionProfiles } = await loadGatewayConfig()
      // Workflow's named profile must not appear as a gateway-global profile.
      expect(config.defaults?.permissionProfiles?.analyst).toBeUndefined()
      expect(hasExplicitPermissionProfiles).toBe(false)
    })

    it('uses SKELM_GATEWAY_CONFIG path and merges co-located skelm.config.*', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-dual-envvar-'))
      const gatewayPath = writeConfig(
        dir,
        'skelm.gateway.mjs',
        `
        export default { server: { port: 5555 } }
      `,
      )
      writeConfig(
        dir,
        'skelm.config.mjs',
        `
        const b = { id: 'env-var-backend', infer: async () => ({}) }
        export default { instances: [b] }
      `,
      )
      process.env.SKELM_GATEWAY_CONFIG = gatewayPath
      const { config } = await loadGatewayConfig()
      expect(config.server?.port).toBe(5555)
      expect(config.instances?.[0]?.id).toBe('env-var-backend')
    })
  })
})
