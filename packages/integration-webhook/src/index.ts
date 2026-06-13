/**
 * @skelm/integration-webhook
 *
 * A generic inbound webhook trigger built on `@skelm/integration-sdk`. It
 * provides a typed {@link TriggerDefinition} + endpoint descriptor, an HMAC
 * (or explicit-insecure no-verification) {@link WebhookVerification} strategy
 * keyed by {@link CredentialReference}, and a normalizer that maps the raw
 * request into the SDK {@link EventEnvelope}.
 *
 * It does NOT run an HTTP server: the gateway owns the inbound webhook HTTP
 * surface and secret resolution. This package supplies the descriptor,
 * verification, and normalization the gateway composes with that surface.
 */

export {
  verifyWebhookRequest,
  verificationCredentialRefs,
} from './verification.js'
export type {
  HmacWebhookVerification,
  NoWebhookVerification,
  WebhookVerification,
  WebhookVerificationResult,
  HeaderLookup,
  VerifyWebhookRequestInput,
} from './verification.js'

export { defineWebhookTrigger, normalizeWebhookRequest } from './trigger.js'
export type {
  WebhookFieldMapping,
  WebhookNormalizationConfig,
  WebhookTriggerConfig,
  RawWebhookRequest,
  WebhookTrigger,
} from './trigger.js'

export { buildWebhookManifest } from './manifest.js'
export type { BuildWebhookManifestOptions } from './manifest.js'

export { GENERIC_WEBHOOK_FIXTURE } from './fixtures.js'
