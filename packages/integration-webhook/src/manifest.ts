/**
 * Build the {@link IntegrationPackageManifest} for a generic webhook trigger:
 * the trigger definition, endpoint descriptor, the credential schema/refs the
 * verification strategy needs, dashboard setup metadata, a mock fixture of
 * canned payloads, and an audit redaction policy.
 */

import type {
  AuditRedactionPolicy,
  CredentialSchema,
  DashboardSetupMetadata,
  IntegrationPackageManifest,
  MockProviderFixture,
} from '@skelm/integration-sdk'
import type { WebhookTrigger } from './trigger.js'

const PACKAGE_NAME = '@skelm/integration-webhook'
const PACKAGE_VERSION = '0.4.8'

export interface BuildWebhookManifestOptions {
  readonly trigger: WebhookTrigger
  readonly description?: string
  readonly dashboard?: DashboardSetupMetadata
  readonly mockFixtures?: readonly MockProviderFixture[]
  /** Extra audit-redaction field paths on top of the always-redacted secret. */
  readonly redactPaths?: readonly string[]
}

/**
 * Assemble the integration manifest for a webhook trigger. When the trigger
 * verifies via HMAC, the manifest declares the signing-secret credential
 * (by reference/shape only — never a value) so the gateway knows what to
 * resolve. The redaction policy always names the signing-secret header so its
 * value can never reach audit rows or logs.
 */
export function buildWebhookManifest(
  options: BuildWebhookManifestOptions,
): IntegrationPackageManifest {
  const { trigger } = options
  const { verification } = trigger.config

  const credentials: readonly CredentialSchema[] =
    verification.strategy === 'hmac'
      ? [
          {
            id: `${trigger.config.id}-signing-secret`,
            description: 'Shared HMAC signing secret for inbound webhook verification.',
            fields: [
              {
                name: verification.secretRef.secretName,
                kind: 'token',
                description: 'Signing secret; resolved by the gateway, never stored here.',
              },
            ],
          },
        ]
      : []

  const redactPaths: readonly string[] =
    verification.strategy === 'hmac'
      ? [`headers.${verification.signatureHeader.toLowerCase()}`, ...(options.redactPaths ?? [])]
      : [...(options.redactPaths ?? [])]

  const auditRedaction: AuditRedactionPolicy = { redactPaths }

  return {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    description:
      options.description ?? 'Generic inbound webhook trigger with HMAC signature verification.',
    triggers: [trigger.definition],
    webhooks: [trigger.endpoint],
    ...(credentials.length > 0 ? { credentials } : {}),
    ...(trigger.config.events !== undefined ? { supportedEvents: trigger.config.events } : {}),
    ...(options.dashboard !== undefined ? { dashboard: options.dashboard } : {}),
    ...(options.mockFixtures !== undefined ? { mockFixtures: options.mockFixtures } : {}),
    auditRedaction,
  }
}
