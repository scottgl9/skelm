import type { IntegrationPackageManifest } from '@skelm/integration-sdk'
import { describe, expect, it } from 'vitest'
import { runDoctor } from '../src/doctor.js'
import { REDACTED } from '../src/redact.js'

// Assembled from fragments so no secret-shaped literal is committed.
const FAKE_TOKEN = ['xoxb', '0000000000', 'ABCDEFGHIJKLMNOP'].join('-')

function baseManifest(
  overrides: Partial<IntegrationPackageManifest> = {},
): IntegrationPackageManifest {
  return {
    name: '@example/synthetic',
    version: '1.0.0',
    credentials: [
      {
        id: 'synthetic',
        fields: [
          { name: 'botToken', kind: 'token' },
          { name: 'baseUrl', kind: 'url', optional: true },
        ],
      },
    ],
    ...overrides,
  }
}

const FIXED_NOW = () => 0

describe('runDoctor — credential completeness', () => {
  it('fails with remediation when a required credential ref is missing', async () => {
    const report = await runDoctor({ manifest: baseManifest(), now: FIXED_NOW })
    const c = report.checks.find((x) => x.id === 'credentials:synthetic.botToken')
    expect(c?.status).toBe('fail')
    expect(c?.remediation).toBeDefined()
    expect(c?.remediation).toContain('botToken')
    expect(report.overall).toBe('fail')
  })

  it('passes when the required credential ref is resolvable', async () => {
    const report = await runDoctor({
      manifest: baseManifest(),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      now: FIXED_NOW,
    })
    const c = report.checks.find((x) => x.id === 'credentials:synthetic.botToken')
    expect(c?.status).toBe('pass')
  })

  it('matches a credential ref by its field when present', async () => {
    const report = await runDoctor({
      manifest: baseManifest(),
      resolvedCredentialRefs: [
        { kind: 'credential-ref', secretName: 'PROD_TOKEN', field: 'botToken' },
      ],
      now: FIXED_NOW,
    })
    expect(report.checks.find((x) => x.id === 'credentials:synthetic.botToken')?.status).toBe(
      'pass',
    )
  })

  it('warns (not fails) for a missing optional credential', async () => {
    const report = await runDoctor({
      manifest: baseManifest(),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      now: FIXED_NOW,
    })
    expect(report.checks.find((x) => x.id === 'credentials:synthetic.baseUrl')?.status).toBe('warn')
  })
})

describe('runDoctor — health probe', () => {
  it('passes for a healthy provider', async () => {
    const report = await runDoctor({
      manifest: baseManifest(),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      healthProbe: async () => ({
        healthy: true,
        status: 'ok',
        checkedAt: new Date(0).toISOString(),
      }),
      now: FIXED_NOW,
    })
    expect(report.checks.find((x) => x.id === 'health:provider')?.status).toBe('pass')
  })

  it('fails with remediation for an unhealthy provider', async () => {
    const report = await runDoctor({
      manifest: baseManifest(),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      healthProbe: async () => ({
        healthy: false,
        status: 'unhealthy',
        checkedAt: new Date(0).toISOString(),
      }),
      now: FIXED_NOW,
    })
    const c = report.checks.find((x) => x.id === 'health:provider')
    expect(c?.status).toBe('fail')
    expect(c?.remediation).toBeDefined()
  })

  it('fails gracefully when the health probe throws', async () => {
    const report = await runDoctor({
      manifest: baseManifest(),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      healthProbe: async () => {
        throw new Error('connection refused')
      },
      now: FIXED_NOW,
    })
    const c = report.checks.find((x) => x.id === 'health:provider')
    expect(c?.status).toBe('fail')
    expect(c?.summary).toContain('connection refused')
  })
})

describe('runDoctor — webhook checks', () => {
  it('warns when a webhook declares no verification strategy', async () => {
    const report = await runDoctor({
      manifest: baseManifest({
        webhooks: [{ path: '/webhooks/x', verification: 'none' }],
      }),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      now: FIXED_NOW,
    })
    const c = report.checks.find((x) => x.id === 'webhook:/webhooks/x:verification')
    expect(c?.status).toBe('warn')
    expect(c?.remediation).toBeDefined()
  })

  it('passes verification when a strategy is declared', async () => {
    const report = await runDoctor({
      manifest: baseManifest({ webhooks: [{ path: '/webhooks/x', verification: 'hmac' }] }),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      now: FIXED_NOW,
    })
    expect(report.checks.find((x) => x.id === 'webhook:/webhooks/x:verification')?.status).toBe(
      'pass',
    )
  })

  it('fails reachability when the webhook probe reports unreachable', async () => {
    const report = await runDoctor({
      manifest: baseManifest({ webhooks: [{ path: '/webhooks/x', verification: 'hmac' }] }),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      webhookProbe: async () => ({ reachable: false, detail: 'timeout' }),
      now: FIXED_NOW,
    })
    expect(report.checks.find((x) => x.id === 'webhook:/webhooks/x:reachability')?.status).toBe(
      'fail',
    )
  })
})

describe('runDoctor — scope checks', () => {
  it('fails when a required scope is not granted', async () => {
    const report = await runDoctor({
      manifest: baseManifest(),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      scopeRequirements: [
        { credentialSchemaId: 'synthetic', requiredScopes: ['chat:write', 'files:read'] },
      ],
      scopeProbe: async () => ['chat:write'],
      now: FIXED_NOW,
    })
    const c = report.checks.find((x) => x.id === 'scope:synthetic')
    expect(c?.status).toBe('fail')
    expect(c?.summary).toContain('files:read')
  })

  it('passes when all required scopes are granted', async () => {
    const report = await runDoctor({
      manifest: baseManifest(),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      scopeRequirements: [{ credentialSchemaId: 'synthetic', requiredScopes: ['chat:write'] }],
      scopeProbe: async () => ['chat:write', 'files:read'],
      now: FIXED_NOW,
    })
    expect(report.checks.find((x) => x.id === 'scope:synthetic')?.status).toBe('pass')
  })
})

describe('runDoctor — rate-limit detection', () => {
  it('reports a pass when the manifest declares rate-limit metadata', async () => {
    const report = await runDoctor({
      manifest: baseManifest({
        dashboard: { fields: { rateLimit: { requests: 1, windowMs: 1 } } },
      }),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      now: FIXED_NOW,
    })
    expect(report.checks.find((x) => x.id === 'rate-limit:declared')?.status).toBe('pass')
  })

  it('omits the rate-limit check when none is declared', async () => {
    const report = await runDoctor({
      manifest: baseManifest(),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      now: FIXED_NOW,
    })
    expect(report.checks.find((x) => x.kind === 'rate-limit')).toBeUndefined()
  })
})

describe('runDoctor — mock-fixture replay', () => {
  it('runs the injected replay and records the result', async () => {
    const seen: string[] = []
    const report = await runDoctor({
      manifest: baseManifest({
        mockFixtures: [{ provider: 'synthetic', payloads: { evt: { a: 1 } } }],
      }),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      mockFixtureReplay: async (f) => {
        seen.push(f.provider)
        return { ok: true }
      },
      now: FIXED_NOW,
    })
    expect(seen).toEqual(['synthetic'])
    expect(report.checks.find((x) => x.id === 'mock-fixture:synthetic')?.status).toBe('pass')
  })

  it('counts shipped payloads when no replay is injected', async () => {
    const report = await runDoctor({
      manifest: baseManifest({
        mockFixtures: [{ provider: 'synthetic', payloads: { evt: { a: 1 } } }],
      }),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      now: FIXED_NOW,
    })
    expect(report.checks.find((x) => x.id === 'mock-fixture:synthetic')?.status).toBe('pass')
  })

  it('fails when the injected replay reports failure', async () => {
    const report = await runDoctor({
      manifest: baseManifest({
        mockFixtures: [{ provider: 'synthetic', payloads: { evt: { a: 1 } } }],
      }),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      mockFixtureReplay: async () => ({ ok: false, detail: 'shape mismatch' }),
      now: FIXED_NOW,
    })
    expect(report.checks.find((x) => x.id === 'mock-fixture:synthetic')?.status).toBe('fail')
  })
})

describe('runDoctor — redaction', () => {
  it('never lets a secret value reach the report, even from a probe detail', async () => {
    const report = await runDoctor({
      manifest: baseManifest(),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      healthProbe: async () => ({
        healthy: true,
        status: 'ok',
        checkedAt: new Date(0).toISOString(),
        detail: `authed with token=${FAKE_TOKEN}`,
      }),
      now: FIXED_NOW,
    })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(FAKE_TOKEN)
    expect(serialized).toContain(REDACTED)
  })

  it('redacts a secret embedded in a webhook probe detail too', async () => {
    const report = await runDoctor({
      manifest: baseManifest({ webhooks: [{ path: '/wh', verification: 'hmac' }] }),
      resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
      webhookProbe: async () => ({ reachable: true, detail: `secret: ${FAKE_TOKEN}` }),
      now: FIXED_NOW,
    })
    expect(JSON.stringify(report)).not.toContain(FAKE_TOKEN)
  })

  it('produces a deterministic generatedAt from the injected clock', async () => {
    const report = await runDoctor({ manifest: baseManifest(), now: () => 0 })
    expect(report.generatedAt).toBe(new Date(0).toISOString())
  })
})
