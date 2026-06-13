/**
 * @skelm/integration-doctor
 *
 * A diagnostic doctor for skelm integrations. Given an
 * `IntegrationPackageManifest` (and gateway-supplied probes for the privileged
 * checks), it produces a structured report covering credential-schema
 * completeness, provider health, webhook reachability and verification-strategy
 * presence, credential scopes, rate-limit declaration, and mock-fixture replay.
 *
 * It is generic over the integration-sdk contracts — it depends on no concrete
 * provider package — and never carries or emits a secret value: credential
 * inputs are references (names) only, and every report string is redacted.
 */

export { runDoctor } from './doctor.js'
export { redact, REDACTED } from './redact.js'
export type {
  DoctorCheck,
  DoctorCheckKind,
  DoctorCheckStatus,
  DoctorInput,
  DoctorReport,
  HealthProbe,
  MockFixtureReplay,
  ScopeProbe,
  ScopeRequirement,
  WebhookProbe,
} from './types.js'
