/**
 * The integration doctor.
 *
 * Given an {@link IntegrationPackageManifest} and gateway-supplied probes, run a
 * diagnostic report against the integration-sdk contracts. The doctor is
 * generic over any integration — it imports no concrete provider package and
 * reasons only about the manifest's declared shape and the injected probes. It
 * performs no network or filesystem I/O itself; privileged work (health checks,
 * webhook reachability, scope lookup) is delegated to gateway-supplied probes.
 */

import type {
  CredentialFieldSchema,
  CredentialSchema,
  WebhookEndpointDescriptor,
} from '@skelm/integration-sdk'
import { redact } from './redact.js'
import type {
  DoctorCheck,
  DoctorCheckStatus,
  DoctorInput,
  DoctorReport,
  ScopeRequirement,
} from './types.js'

function worst(a: DoctorCheckStatus, b: DoctorCheckStatus): DoctorCheckStatus {
  const rank: Record<DoctorCheckStatus, number> = { pass: 0, warn: 1, fail: 2 }
  return rank[a] >= rank[b] ? a : b
}

function check(c: DoctorCheck): DoctorCheck {
  const summary = redact(c.summary) ?? c.summary
  const remediation = redact(c.remediation)
  return remediation === undefined ? { ...c, summary } : { ...c, summary, remediation }
}

function checkCredentials(
  schema: CredentialSchema,
  resolvedNames: ReadonlySet<string>,
): DoctorCheck[] {
  const out: DoctorCheck[] = []
  for (const field of schema.fields) {
    out.push(checkCredentialField(schema, field, resolvedNames))
  }
  return out
}

function checkCredentialField(
  schema: CredentialSchema,
  field: CredentialFieldSchema,
  resolvedNames: ReadonlySet<string>,
): DoctorCheck {
  const present = resolvedNames.has(field.name)
  const id = `credentials:${schema.id}.${field.name}`
  if (present) {
    return check({
      kind: 'credentials',
      id,
      status: 'pass',
      summary: `Credential "${field.name}" (${field.kind}) is configured.`,
    })
  }
  if (field.optional === true) {
    return check({
      kind: 'credentials',
      id,
      status: 'warn',
      summary: `Optional credential "${field.name}" is not configured.`,
      remediation: `Provide a secret reference named "${field.name}" if this integration feature is needed.`,
    })
  }
  return check({
    kind: 'credentials',
    id,
    status: 'fail',
    summary: `Required credential "${field.name}" (${field.kind}) is missing.`,
    remediation: `Register a gateway secret and add a credential reference named "${field.name}" for credential set "${schema.id}".`,
  })
}

function checkWebhook(endpoint: WebhookEndpointDescriptor): DoctorCheck {
  const id = `webhook:${endpoint.path}:verification`
  if (endpoint.verification === 'none') {
    return check({
      kind: 'webhook',
      id,
      status: 'warn',
      summary: `Webhook "${endpoint.path}" declares no verification strategy.`,
      remediation:
        'Add an hmac, signature-header, or token verification strategy so forged inbound requests are rejected.',
    })
  }
  return check({
    kind: 'webhook',
    id,
    status: 'pass',
    summary: `Webhook "${endpoint.path}" verifies inbound requests via "${endpoint.verification}".`,
  })
}

async function checkWebhookReachability(
  endpoint: WebhookEndpointDescriptor,
  probe: NonNullable<DoctorInput['webhookProbe']>,
): Promise<DoctorCheck> {
  const id = `webhook:${endpoint.path}:reachability`
  try {
    const result = await probe(endpoint)
    if (result.reachable) {
      return check({
        kind: 'webhook',
        id,
        status: 'pass',
        summary: `Webhook "${endpoint.path}" is reachable.${result.detail ? ` ${result.detail}` : ''}`,
      })
    }
    return check({
      kind: 'webhook',
      id,
      status: 'fail',
      summary: `Webhook "${endpoint.path}" is not reachable.${result.detail ? ` ${result.detail}` : ''}`,
      remediation:
        'Confirm the gateway is publicly routable and the endpoint path is registered with the provider.',
    })
  } catch (error) {
    return check({
      kind: 'webhook',
      id,
      status: 'fail',
      summary: `Webhook reachability probe for "${endpoint.path}" threw: ${errorMessage(error)}`,
      remediation: 'Inspect gateway logs for the failing webhook probe.',
    })
  }
}

async function checkHealth(probe: NonNullable<DoctorInput['healthProbe']>): Promise<DoctorCheck> {
  const id = 'health:provider'
  try {
    const result = await probe()
    if (result.healthy) {
      return check({
        kind: 'health',
        id,
        status: 'pass',
        summary: `Provider health check passed (${result.status}).${result.detail ? ` ${result.detail}` : ''}`,
      })
    }
    return check({
      kind: 'health',
      id,
      status: 'fail',
      summary: `Provider health check failed (${result.status}).${result.detail ? ` ${result.detail}` : ''}`,
      remediation:
        'Verify the credential values resolve and the provider endpoint is up; re-run the connection test.',
    })
  } catch (error) {
    return check({
      kind: 'health',
      id,
      status: 'fail',
      summary: `Provider health check threw: ${errorMessage(error)}`,
      remediation: 'Inspect gateway logs for the failing health probe.',
    })
  }
}

async function checkScopes(
  requirement: ScopeRequirement,
  probe: NonNullable<DoctorInput['scopeProbe']>,
): Promise<DoctorCheck> {
  const id = `scope:${requirement.credentialSchemaId}`
  try {
    const granted = new Set(await probe(requirement.credentialSchemaId))
    const missing = requirement.requiredScopes.filter((s) => !granted.has(s))
    if (missing.length === 0) {
      return check({
        kind: 'scope',
        id,
        status: 'pass',
        summary: `All ${requirement.requiredScopes.length} required scope(s) granted for "${requirement.credentialSchemaId}".`,
      })
    }
    return check({
      kind: 'scope',
      id,
      status: 'fail',
      summary: `Missing scope(s) for "${requirement.credentialSchemaId}": ${missing.join(', ')}.`,
      remediation: `Grant the missing scope(s) on the provider credential: ${missing.join(', ')}.`,
    })
  } catch (error) {
    return check({
      kind: 'scope',
      id,
      status: 'fail',
      summary: `Scope probe for "${requirement.credentialSchemaId}" threw: ${errorMessage(error)}`,
      remediation: 'Inspect gateway logs for the failing scope probe.',
    })
  }
}

function checkRateLimit(input: DoctorInput): DoctorCheck | null {
  const dashboardFields = input.manifest.dashboard?.fields ?? {}
  const declared = 'rateLimit' in dashboardFields || 'rateLimits' in dashboardFields
  if (!declared) return null
  return check({
    kind: 'rate-limit',
    id: 'rate-limit:declared',
    status: 'pass',
    summary: 'Integration declares rate-limit metadata.',
  })
}

async function replayMockFixtures(input: DoctorInput): Promise<DoctorCheck[]> {
  const fixtures = input.manifest.mockFixtures ?? []
  const replay = input.mockFixtureReplay
  const out: DoctorCheck[] = []
  for (const fixture of fixtures) {
    const id = `mock-fixture:${fixture.provider}`
    if (replay === undefined) {
      const count = Object.keys(fixture.payloads).length
      out.push(
        check({
          kind: 'mock-fixture',
          id,
          status: count > 0 ? 'pass' : 'warn',
          summary:
            count > 0
              ? `Mock fixture "${fixture.provider}" ships ${count} canned payload(s).`
              : `Mock fixture "${fixture.provider}" ships no payloads.`,
          ...(count > 0
            ? {}
            : { remediation: 'Add at least one canned payload so CI can replay this fixture.' }),
        }),
      )
      continue
    }
    try {
      const result = await replay(fixture)
      out.push(
        check({
          kind: 'mock-fixture',
          id,
          status: result.ok ? 'pass' : 'fail',
          summary: `Mock fixture "${fixture.provider}" replay ${result.ok ? 'succeeded' : 'failed'}.${result.detail ? ` ${result.detail}` : ''}`,
          ...(result.ok
            ? {}
            : {
                remediation:
                  'The fixture payload did not normalize to the expected shape; update the fixture or adapter.',
              }),
        }),
      )
    } catch (error) {
      out.push(
        check({
          kind: 'mock-fixture',
          id,
          status: 'fail',
          summary: `Mock fixture "${fixture.provider}" replay threw: ${errorMessage(error)}`,
          remediation: 'Fix the fixture or the adapter factory it drives.',
        }),
      )
    }
  }
  return out
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run the full diagnostic and return a structured {@link DoctorReport}. Pure
 * orchestration over the manifest and injected probes; no I/O of its own. Every
 * string in the returned report is redaction-scrubbed.
 */
export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const { manifest } = input
  const resolvedNames = new Set(
    (input.resolvedCredentialRefs ?? []).map((ref) => ref.field ?? ref.secretName),
  )
  const checks: DoctorCheck[] = []

  for (const schema of manifest.credentials ?? []) {
    checks.push(...checkCredentials(schema, resolvedNames))
  }

  if (input.healthProbe) {
    checks.push(await checkHealth(input.healthProbe))
  }

  for (const endpoint of manifest.webhooks ?? []) {
    checks.push(checkWebhook(endpoint))
    if (input.webhookProbe) {
      checks.push(await checkWebhookReachability(endpoint, input.webhookProbe))
    }
  }

  if (input.scopeProbe) {
    for (const requirement of input.scopeRequirements ?? []) {
      checks.push(await checkScopes(requirement, input.scopeProbe))
    }
  }

  const rateLimit = checkRateLimit(input)
  if (rateLimit) checks.push(rateLimit)

  checks.push(...(await replayMockFixtures(input)))

  const overall = checks.reduce<DoctorCheckStatus>((acc, c) => worst(acc, c.status), 'pass')
  const now = input.now ?? Date.now

  return {
    integration: manifest.name,
    version: manifest.version,
    overall,
    checks,
    generatedAt: new Date(now()).toISOString(),
  }
}
