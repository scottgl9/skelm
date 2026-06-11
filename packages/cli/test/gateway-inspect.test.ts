import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { gatewayInspectCommand, getConfigPath, redactConfig } from '../src/gateway-inspect.js'

function fakeIo() {
  let out = ''
  let err = ''
  return {
    io: {
      stdout: {
        write: (s: string) => {
          out += s
        },
      },
      stderr: {
        write: (s: string) => {
          err += s
        },
      },
    },
    get out() {
      return out
    },
    get err() {
      return err
    },
  }
}

function writeGatewayConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'skelm-gw-inspect-'))
  const path = join(dir, 'skelm.gateway.mjs')
  writeFileSync(path, body)
  return path
}

describe('redactConfig', () => {
  it('replaces { secret } refs and credential-keyed strings', () => {
    expect(redactConfig({ secret: 'OPENAI_KEY' })).toBe('<secret:OPENAI_KEY>')
    expect(redactConfig({ apiKey: 'sk-abc', model: 'gpt' })).toEqual({
      apiKey: '<redacted>',
      model: 'gpt',
    })
    expect(redactConfig({ server: { auth: { token: 't0p' }, port: 8080 } })).toEqual({
      server: { auth: { token: '<redacted>' }, port: 8080 },
    })
  })

  it('collapses constructed instances and preserves non-secret values', () => {
    expect(redactConfig({ instances: [() => undefined], name: 'x' })).toEqual({
      instances: ['<instance>'],
      name: 'x',
    })
    expect(redactConfig('plain')).toBe('plain')
    expect(redactConfig({ baseUrl: 'http://x', headers: { 'X-Title': 'skelm' } })).toEqual({
      baseUrl: 'http://x',
      headers: { 'X-Title': 'skelm' },
    })
  })
})

describe('getConfigPath', () => {
  it('resolves a dotted path and reports missing segments', () => {
    const o = { server: { port: 8080 } }
    expect(getConfigPath(o, 'server.port')).toEqual({ found: true, value: 8080 })
    expect(getConfigPath(o, 'server.host')).toEqual({ found: false, value: undefined })
    expect(getConfigPath(o, 'nope')).toEqual({ found: false, value: undefined })
  })
})

describe('gatewayInspectCommand', () => {
  const body =
    'export default { server: { port: 8123, auth: { mode: "token", token: "supersecret" } }, backends: { agent: { baseUrl: "http://x", apiKey: { secret: "OPENAI_KEY" } }, infer: "agent" } }'

  it('config get returns a scalar at a dotted path', async () => {
    const path = writeGatewayConfig(body)
    const f = fakeIo()
    const r = await gatewayInspectCommand(
      { subcommand: 'config', action: 'get', path: 'server.port', gatewayConfig: path },
      f.io,
    )
    expect(r.exitCode).toBe(0)
    expect(f.out.trim()).toBe('8123')
  })

  it('config list redacts secrets and never prints the raw value', async () => {
    const path = writeGatewayConfig(body)
    const f = fakeIo()
    const r = await gatewayInspectCommand(
      { subcommand: 'config', action: 'list', gatewayConfig: path },
      f.io,
    )
    expect(r.exitCode).toBe(0)
    expect(f.out).not.toContain('supersecret')
    expect(f.out).toContain('<redacted>')
    expect(f.out).toContain('<secret:OPENAI_KEY>')
    expect(f.out).toContain('8123')
  })

  it('config get errors on a missing path with a non-zero exit', async () => {
    const path = writeGatewayConfig(body)
    const f = fakeIo()
    const r = await gatewayInspectCommand(
      { subcommand: 'config', action: 'get', path: 'server.nope', gatewayConfig: path },
      f.io,
    )
    expect(r.exitCode).toBe(1)
    expect(f.err).toContain('no config value')
  })

  it('backend list shows configured backend ids', async () => {
    const path = writeGatewayConfig(body)
    const f = fakeIo()
    const r = await gatewayInspectCommand(
      { subcommand: 'backend', action: 'list', gatewayConfig: path },
      f.io,
    )
    expect(r.exitCode).toBe(0)
    expect(f.out).toContain('- agent')
    expect(f.out).toContain('- infer')
  })
})

describe('redactConfig — secret-leak regressions', () => {
  it('redacts a bare string under a credential key (the `config get <secret>` path)', () => {
    // `config get server.auth.token` resolves to a BARE string; with no key
    // context the redactor used to pass it through verbatim — a direct leak.
    expect(redactConfig('supersecret', 'token')).toBe('<redacted>')
    expect(redactConfig('sk-abc', 'apiKey')).toBe('<redacted>')
    // Non-credential keys (and no key at all) still pass through untouched.
    expect(redactConfig('http://x', 'baseUrl')).toBe('http://x')
    expect(redactConfig('plain')).toBe('plain')
  })

  it('redacts inline secrets under compound credential keys (signingSecret, refreshToken, …)', () => {
    // Anchored exact-match missed every compound key. signingSecret is a real
    // Slack-trigger field (packages/core/src/triggers/slack.ts).
    expect(redactConfig({ signingSecret: 'shh', port: 1 })).toEqual({
      signingSecret: '<redacted>',
      port: 1,
    })
    expect(redactConfig({ refreshToken: 'rt', clientSecret: 'cs', privateKey: 'pk' })).toEqual({
      refreshToken: '<redacted>',
      clientSecret: '<redacted>',
      privateKey: '<redacted>',
    })
  })

  it('propagates key context through arrays of inline secrets', () => {
    expect(redactConfig(['a', 'b'], 'tokens')).toEqual(['<redacted>', '<redacted>'])
  })
})

describe('gatewayInspectCommand — secret-leak regressions', () => {
  it('config get of an inline secret redacts rather than printing it', async () => {
    const path = writeGatewayConfig(
      'export default { server: { auth: { mode: "token", token: "supersecret" } } }',
    )
    const f = fakeIo()
    const r = await gatewayInspectCommand(
      { subcommand: 'config', action: 'get', path: 'server.auth.token', gatewayConfig: path },
      f.io,
    )
    expect(r.exitCode).toBe(0)
    expect(f.out).not.toContain('supersecret')
    expect(f.out.trim()).toBe('<redacted>')
  })

  it('config list redacts an inline signingSecret (compound credential key)', async () => {
    const path = writeGatewayConfig(
      'export default { triggers: { slack: { signingSecret: "shhh-do-not-leak" } } }',
    )
    const f = fakeIo()
    const r = await gatewayInspectCommand(
      { subcommand: 'config', action: 'list', gatewayConfig: path },
      f.io,
    )
    expect(r.exitCode).toBe(0)
    expect(f.out).not.toContain('shhh-do-not-leak')
    expect(f.out).toContain('<redacted>')
  })
})
