/**
 * Ed25519 interaction-signature verification for Discord.
 *
 * Discord signs every Interactions webhook request with the application's
 * Ed25519 key. The request carries two headers:
 *   - `X-Signature-Ed25519`   — the hex-encoded detached signature
 *   - `X-Signature-Timestamp` — the timestamp prefixed to the body
 * The verified message is `timestamp + rawBody`, and the verifying key is the
 * application's public key (the 32-byte raw Ed25519 key, hex-encoded, shown in
 * the Developer Portal as the "Public Key").
 *
 * The SDK's {@link verifyHmacSignature} helper only covers symmetric HMAC, so
 * this is a Discord-specific Ed25519 verifier built on `node:crypto`. Node's
 * `crypto.verify(null, …)` selects Ed25519 from the key type. We wrap the raw
 * 32-byte public key into a minimal SPKI DER structure so `createPublicKey`
 * accepts it. Verification never throws on malformed input — any decode or key
 * error returns `false` so an attacker cannot distinguish rejection reasons or
 * crash the request handler.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

/** SPKI DER prefix for a raw 32-byte Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** Header Discord sends the hex-encoded Ed25519 signature in. */
export const DISCORD_SIGNATURE_HEADER = 'x-signature-ed25519'
/** Header Discord sends the signing timestamp in. */
export const DISCORD_TIMESTAMP_HEADER = 'x-signature-timestamp'

export interface VerifyDiscordInteractionOptions {
  /** Raw request body bytes exactly as received — never re-serialized JSON. */
  readonly rawBody: string
  /** Value of the `X-Signature-Ed25519` header (hex). */
  readonly signature: string
  /** Value of the `X-Signature-Timestamp` header. */
  readonly timestamp: string
  /** The application's public key (hex, 32 raw bytes) from the Developer Portal. */
  readonly publicKey: string
}

function rawPublicKeyToSpki(hexKey: string): Buffer | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) return null
  return Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hexKey, 'hex')])
}

/**
 * Verify a Discord interaction request signature. Returns `true` only when the
 * detached Ed25519 signature over `timestamp + rawBody` validates against the
 * application's public key. Any malformed header, key, or signature yields
 * `false` rather than throwing.
 */
export function verifyDiscordInteraction(opts: VerifyDiscordInteractionOptions): boolean {
  if (opts.signature.length === 0 || opts.timestamp.length === 0) return false
  if (!/^[0-9a-fA-F]+$/.test(opts.signature) || opts.signature.length % 2 !== 0) return false
  const spki = rawPublicKeyToSpki(opts.publicKey)
  if (spki === null) return false
  try {
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    const message = Buffer.from(`${opts.timestamp}${opts.rawBody}`, 'utf8')
    const sig = Buffer.from(opts.signature, 'hex')
    return cryptoVerify(null, message, key, sig)
  } catch {
    return false
  }
}

/**
 * Convenience wrapper that pulls the two signature headers out of a header map
 * (case-insensitive) and verifies. Returns `false` when either header is
 * absent. The header map values may be `string` or `string[]` (as Node's HTTP
 * layer may provide); arrays use the first element.
 */
export function verifyDiscordInteractionFromHeaders(args: {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly rawBody: string
  readonly publicKey: string
}): boolean {
  const signature = headerValue(args.headers, DISCORD_SIGNATURE_HEADER)
  const timestamp = headerValue(args.headers, DISCORD_TIMESTAMP_HEADER)
  if (signature === undefined || timestamp === undefined) return false
  return verifyDiscordInteraction({
    rawBody: args.rawBody,
    signature,
    timestamp,
    publicKey: args.publicKey,
  })
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    if (Array.isArray(value)) return value[0]
    return value
  }
  return undefined
}
