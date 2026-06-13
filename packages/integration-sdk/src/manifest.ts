/**
 * Integration-package manifest — the declarative metadata an integration
 * package exposes at runtime.
 *
 * This is intentionally SDK-side and code-level, NOT the JSON
 * `skelm.package.json` (`WorkflowPackageManifest` in `@skelm/core`). That JSON
 * manifest is the on-disk trust boundary parsed before any package code runs,
 * so it can only hold JSON-serializable, statically-validated metadata
 * (workflow entries, secret refs by name, string triggers). An integration
 * package's actions, triggers, conversation adapters, mock fixtures, and
 * live-test descriptors are code objects (functions, adapter instances) that
 * cannot live in JSON. So the integration manifest is a typed runtime
 * descriptor a package exports; the gateway reads it after load to register the
 * package's surface and render the dashboard. The two manifests are
 * complementary: the JSON manifest gates loading; this descriptor describes the
 * loaded integration's capabilities.
 */

import type { CapabilityDescriptor } from './conversation.js'
import type { CredentialSchema } from './credentials.js'
import type { DeliveryTarget } from './delivery.js'
import type { LiveTestDescriptor, MockProviderFixture } from './testing.js'

/** A typed action an integration exposes (e.g. `sendMessage`, `createIssue`). */
export interface ActionDefinition {
  readonly id: string
  readonly description?: string
  /** Permission dimensions this action requires (default-deny when omitted). */
  readonly requiredPermissions?: readonly string[]
}

/** A trigger an integration offers (webhook/poll/event-source). */
export interface TriggerDefinition {
  readonly id: string
  readonly kind: 'webhook' | 'poll' | 'event-source'
  readonly description?: string
  /** Provider event types this trigger can emit. */
  readonly events?: readonly string[]
}

/** How an inbound webhook for this package is verified. */
export type WebhookVerificationStrategy = 'hmac' | 'signature-header' | 'token' | 'none'

/** A webhook endpoint the package serves, plus its verification strategy. */
export interface WebhookEndpointDescriptor {
  /** Gateway-relative path (e.g. `/webhooks/github`). */
  readonly path: string
  readonly verification: WebhookVerificationStrategy
  readonly events?: readonly string[]
}

/**
 * Audit redaction policy: field paths whose values must be redacted from audit
 * rows, logs, and error messages. Secret values are always redacted regardless;
 * this names additional sensitive non-secret fields.
 */
export interface AuditRedactionPolicy {
  /** Dotted field paths to redact (e.g. `payload.user.email`). */
  readonly redactPaths: readonly string[]
}

/** Opaque dashboard setup metadata for the connection wizard. */
export interface DashboardSetupMetadata {
  readonly title?: string
  readonly fields?: Readonly<Record<string, unknown>>
}

/**
 * The declarative surface an integration package exposes. The package's default
 * export (or a named `manifest` export) is this object; the gateway reads it to
 * register actions/triggers/adapters and validate workflows.
 */
export interface IntegrationPackageManifest {
  /** Package identity (npm-style name) and exact version. */
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly actions?: readonly ActionDefinition[]
  readonly triggers?: readonly TriggerDefinition[]
  /** Capability descriptors for conversation adapters this package ships. */
  readonly conversationAdapters?: readonly CapabilityDescriptor[]
  /** Credentials the package requires, by reference/shape only. Never values. */
  readonly credentials?: readonly CredentialSchema[]
  /** Permission dimensions the package needs (default-deny when omitted). */
  readonly requiredPermissions?: readonly string[]
  /** Executable profiles the package needs at runtime, when any. */
  readonly executableProfiles?: readonly string[]
  readonly webhooks?: readonly WebhookEndpointDescriptor[]
  /** Event types the package can emit/consume. */
  readonly supportedEvents?: readonly string[]
  /** Media kinds the package can handle. */
  readonly supportedMedia?: readonly string[]
  /** Default delivery targets the package suggests, when any. */
  readonly deliveryTargets?: readonly DeliveryTarget[]
  readonly dashboard?: DashboardSetupMetadata
  readonly mockFixtures?: readonly MockProviderFixture[]
  readonly liveTests?: readonly LiveTestDescriptor[]
  readonly auditRedaction?: AuditRedactionPolicy
}
