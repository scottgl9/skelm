/**
 * Self-test: run the doctor against a synthetic integration manifest and assert
 * the report shape, statuses, and — critically — that no secret value appears.
 *
 * Runnable directly under Node's TS stripping (`node src/self-test.ts`) so it
 * needs no network, no real provider package, and no external account. Exits
 * non-zero on any assertion failure.
 */

import type { IntegrationPackageManifest } from '@skelm/integration-sdk'
import { REDACTED, runDoctor } from '../dist/index.js'

// Assembled from fragments at runtime so no secret-shaped literal is committed.
const fakeToken = ['xoxb', '1234567890', 'ABCDEFGHIJKLMNOP'].join('-')

const manifest: IntegrationPackageManifest = {
  name: '@example/synthetic-integration',
  version: '0.0.0',
  credentials: [
    {
      id: 'synthetic',
      fields: [
        { name: 'botToken', kind: 'token' },
        { name: 'webhookSecret', kind: 'token' },
        { name: 'baseUrl', kind: 'url', optional: true },
      ],
    },
  ],
  webhooks: [
    { path: '/webhooks/synthetic', verification: 'hmac' },
    { path: '/webhooks/legacy', verification: 'none' },
  ],
  dashboard: { fields: { rateLimit: { requests: 60, windowMs: 60_000 } } },
  mockFixtures: [
    { provider: 'synthetic', payloads: { 'message.created': { id: 'm1', text: 'hi' } } },
  ],
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`self-test FAIL: ${message}`)
    process.exitCode = 1
    throw new Error(message)
  }
}

async function main(): Promise<void> {
  const report = await runDoctor({
    manifest,
    // botToken present; webhookSecret deliberately absent to force a fail.
    resolvedCredentialRefs: [{ kind: 'credential-ref', secretName: 'botToken' }],
    healthProbe: async () => ({
      healthy: true,
      status: 'ok',
      checkedAt: new Date(0).toISOString(),
      // Probe detail intentionally carries a token to prove redaction.
      detail: `connected with ${fakeToken}`,
    }),
    webhookProbe: async () => ({ reachable: true }),
    scopeRequirements: [{ credentialSchemaId: 'synthetic', requiredScopes: ['chat:write'] }],
    scopeProbe: async () => ['chat:write'],
    mockFixtureReplay: async () => ({ ok: true }),
    now: () => 0,
  })

  const byId = new Map(report.checks.map((c) => [c.id, c]))

  assert(
    byId.get('credentials:synthetic.botToken')?.status === 'pass',
    'present credential should pass',
  )
  assert(
    byId.get('credentials:synthetic.webhookSecret')?.status === 'fail',
    'missing required credential should fail',
  )
  assert(
    byId.get('credentials:synthetic.webhookSecret')?.remediation !== undefined,
    'missing credential must carry remediation',
  )
  assert(
    byId.get('credentials:synthetic.baseUrl')?.status === 'warn',
    'missing optional credential should warn',
  )
  assert(byId.get('health:provider')?.status === 'pass', 'healthy provider should pass')
  assert(
    byId.get('webhook:/webhooks/legacy:verification')?.status === 'warn',
    'webhook without verification should warn',
  )
  assert(byId.get('scope:synthetic')?.status === 'pass', 'granted scopes should pass')
  assert(byId.get('rate-limit:declared')?.status === 'pass', 'declared rate-limit should pass')
  assert(
    byId.get('mock-fixture:synthetic')?.status === 'pass',
    'mock fixture replay should run and pass',
  )
  assert(report.overall === 'fail', 'overall should be worst-case fail')

  const serialized = JSON.stringify(report)
  assert(!serialized.includes(fakeToken), 'report must not contain the secret token value')
  assert(
    serialized.includes(REDACTED),
    'report should show a redaction marker for the leaked token',
  )

  console.log(`self-test OK: ${report.checks.length} checks, overall=${report.overall}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
