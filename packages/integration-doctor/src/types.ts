/**
 * Doctor report contracts.
 *
 * The doctor is generic over the integration-sdk contracts: it consumes an
 * {@link IntegrationPackageManifest} plus the resolved-credential-ref *names*
 * the gateway reports as available, and emits a structured report. It never
 * receives or emits secret values — credential inputs are reference names only,
 * mirroring the SDK invariant that credentials in this surface are references.
 */

import type {
  CredentialReference,
  IntegrationPackageManifest,
  MockProviderFixture,
  ProviderHealthCheck,
  WebhookEndpointDescriptor,
} from '@skelm/integration-sdk'

/** Per-check verdict. `pass` healthy, `warn` non-fatal gap, `fail` actionable defect. */
export type DoctorCheckStatus = 'pass' | 'warn' | 'fail'

/** The diagnostic category a check belongs to. */
export type DoctorCheckKind =
  | 'credentials'
  | 'health'
  | 'webhook'
  | 'scope'
  | 'rate-limit'
  | 'mock-fixture'

/** One diagnostic result. Carries no secret values — `detail` is redacted. */
export interface DoctorCheck {
  readonly kind: DoctorCheckKind
  /** Stable id for this specific check (e.g. `credentials:botToken`). */
  readonly id: string
  readonly status: DoctorCheckStatus
  /** One-line human summary. Redacted of any secret-shaped substrings. */
  readonly summary: string
  /** Actionable next step when not `pass`. */
  readonly remediation?: string
}

/** Aggregate report for one integration manifest. */
export interface DoctorReport {
  readonly integration: string
  readonly version: string
  /** Worst status across all checks: `fail` > `warn` > `pass`. */
  readonly overall: DoctorCheckStatus
  readonly checks: readonly DoctorCheck[]
  /** ISO timestamp the report was produced. */
  readonly generatedAt: string
}

/**
 * A declared scope requirement the manifest can attach to a credential set.
 * The SDK manifest does not model scopes natively, so the doctor accepts them
 * as a side input keyed by credential-schema id.
 */
export interface ScopeRequirement {
  /** Credential-schema id the scopes belong to. */
  readonly credentialSchemaId: string
  /** Scope/permission strings the integration needs granted. */
  readonly requiredScopes: readonly string[]
}

/**
 * Probe a single webhook endpoint for reachability. Injected by the gateway
 * (which owns egress); the doctor never performs network I/O itself. Resolves
 * to whether the endpoint responded and an optional non-secret detail.
 */
export type WebhookProbe = (
  endpoint: WebhookEndpointDescriptor,
) => Promise<{ readonly reachable: boolean; readonly detail?: string }>

/**
 * Run a provider health check. Injected by the gateway, which has already
 * resolved credential references to an authenticated transport. The doctor only
 * consumes the {@link ProviderHealthCheck} result.
 */
export type HealthProbe = () => Promise<ProviderHealthCheck>

/**
 * Inspect granted scopes for a credential set. Injected by the gateway. Returns
 * the scopes currently granted so the doctor can diff against requirements.
 */
export type ScopeProbe = (credentialSchemaId: string) => Promise<readonly string[]>

/**
 * Replay a mock fixture. The doctor drives the package's deterministic fixture
 * (no network). Returns whether the replay produced the expected normalized
 * shape and an optional non-secret detail.
 */
export type MockFixtureReplay = (
  fixture: MockProviderFixture,
) => Promise<{ readonly ok: boolean; readonly detail?: string }>

/** Inputs to {@link runDoctor}. All probes are optional and injected by the gateway. */
export interface DoctorInput {
  readonly manifest: IntegrationPackageManifest
  /**
   * Credential references the gateway reports as resolvable (present in the
   * secret store). Names only — never values. A required field whose reference
   * is absent here fails the credential-completeness check.
   */
  readonly resolvedCredentialRefs?: readonly CredentialReference[]
  /** Scope requirements keyed by credential-schema id, when the manifest declares them. */
  readonly scopeRequirements?: readonly ScopeRequirement[]
  readonly healthProbe?: HealthProbe
  readonly webhookProbe?: WebhookProbe
  readonly scopeProbe?: ScopeProbe
  readonly mockFixtureReplay?: MockFixtureReplay
  /** Injected clock for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number
}
