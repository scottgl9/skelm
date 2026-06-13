/**
 * Webhook verification strategy for the generic inbound webhook trigger.
 *
 * SECURITY: the signing secret is named by a {@link CredentialReference} only —
 * this package never reads `process.env`, never stores the secret value, and
 * never logs it. The gateway resolves the reference to an ephemeral value at
 * dispatch and passes it to {@link verifyWebhookRequest}. Verification is
 * default-deny: an HMAC strategy REJECTS when the signature is absent or does
 * not match. The only way to skip verification is the explicit, clearly-marked
 * insecure `no-verification` strategy, which must be opted into deliberately.
 */

import {
  type CredentialReference,
  type HmacAlgorithm,
  verifyHmacSignature,
} from '@skelm/integration-sdk'

/**
 * HMAC verification of an inbound webhook. The signing secret is supplied as a
 * {@link CredentialReference}; the gateway resolves it. The `signatureHeader`
 * names the request header carrying the provider's signature.
 */
export interface HmacWebhookVerification {
  readonly strategy: 'hmac'
  /** Header carrying the provider signature (e.g. `x-hub-signature-256`). */
  readonly signatureHeader: string
  /** Reference to the shared signing secret. Resolved by the gateway; never a value. */
  readonly secretRef: CredentialReference
  readonly algorithm?: HmacAlgorithm
  /** Prefix the provider prepends to the hex digest (e.g. `sha256=`). */
  readonly prefix?: string
  readonly encoding?: 'hex' | 'base64'
}

/**
 * Explicit opt-out of signature verification. INSECURE: any party that can
 * reach the endpoint can fire the trigger. Only use behind a private network
 * boundary or a provider that cannot sign. The literal `acknowledgeInsecure`
 * flag must be set so this can never be selected by accident or omission.
 */
export interface NoWebhookVerification {
  readonly strategy: 'no-verification'
  readonly acknowledgeInsecure: true
}

export type WebhookVerification = HmacWebhookVerification | NoWebhookVerification

/** Outcome of {@link verifyWebhookRequest}. Never carries the secret. */
export type WebhookVerificationResult =
  | { readonly ok: true; readonly strategy: WebhookVerification['strategy'] }
  | {
      readonly ok: false
      readonly reason: 'missing-signature' | 'signature-mismatch'
    }

/** Header lookup the gateway supplies; case-insensitive on the caller side. */
export type HeaderLookup = (name: string) => string | null | undefined

export interface VerifyWebhookRequestInput {
  readonly verification: WebhookVerification
  /** Raw request body bytes exactly as received; never re-serialized. */
  readonly rawBody: string
  readonly header: HeaderLookup
  /**
   * The resolved signing secret. The gateway resolves the
   * {@link HmacWebhookVerification.secretRef} and passes the value here; this
   * package neither resolves the reference nor reads `process.env`. Required
   * for the `hmac` strategy.
   */
  readonly resolvedSecret?: string
}

/**
 * Verify an inbound webhook request against its declared strategy.
 *
 * - `hmac`: rejects on a missing signature header and on any digest mismatch
 *   (constant-time via {@link verifyHmacSignature}). The secret value is read
 *   from `resolvedSecret` only and is never returned, logged, or thrown.
 * - `no-verification`: accepts unconditionally — the caller opted into this.
 */
export function verifyWebhookRequest(input: VerifyWebhookRequestInput): WebhookVerificationResult {
  const { verification } = input
  if (verification.strategy === 'no-verification') {
    return { ok: true, strategy: 'no-verification' }
  }

  const signature = input.header(verification.signatureHeader)
  if (signature === null || signature === undefined || signature.length === 0) {
    return { ok: false, reason: 'missing-signature' }
  }

  const accepted = verifyHmacSignature({
    payload: input.rawBody,
    signature,
    secret: input.resolvedSecret ?? '',
    ...(verification.algorithm ? { algorithm: verification.algorithm } : {}),
    ...(verification.prefix !== undefined ? { prefix: verification.prefix } : {}),
    ...(verification.encoding ? { encoding: verification.encoding } : {}),
  })
  return accepted ? { ok: true, strategy: 'hmac' } : { ok: false, reason: 'signature-mismatch' }
}

/** The credential references a verification strategy declares it needs. */
export function verificationCredentialRefs(
  verification: WebhookVerification,
): readonly CredentialReference[] {
  return verification.strategy === 'hmac' ? [verification.secretRef] : []
}
