/**
 * Credential model for the skelm integration surface.
 *
 * SECURITY INVARIANT: credentials are REFERENCES ONLY in this SDK. A
 * {@link CredentialSchema} declares which secrets an integration NEEDS (by
 * name) and their shape; a {@link CredentialReference} names a single secret by
 * its `secretName`. Neither type can carry a secret value. Secret resolution is
 * gateway-owned — the gateway resolves references to ephemeral values at
 * dispatch time and never persists them. Integration packages must not read
 * `process.env` for secrets and must not persist secret values.
 *
 * The reference types are deliberately closed (no index signature, no `value`
 * field) so that a structurally-typed object carrying a secret value cannot be
 * assigned where a reference is expected. {@link assertNoSecretValue} provides a
 * runtime guard for boundaries where the shape arrived as `unknown`.
 */

/** Declared shape of a single required secret field. */
export type CredentialFieldKind = 'string' | 'token' | 'url' | 'number' | 'boolean'

/** One declared secret an integration requires, by name and shape only. */
export interface CredentialFieldSchema {
  /** Logical field name within the credential set (e.g. `botToken`). */
  readonly name: string
  readonly kind: CredentialFieldKind
  /** When false the field may be omitted by the operator. Defaults to required. */
  readonly optional?: boolean
  readonly description?: string
}

/**
 * The set of secrets an integration declares it needs. This is metadata for the
 * dashboard, validation, and the gateway's secret resolver — it NEVER carries
 * values.
 */
export interface CredentialSchema {
  /** Stable id for this credential set (e.g. `slack`). */
  readonly id: string
  readonly fields: readonly CredentialFieldSchema[]
  readonly description?: string
}

/**
 * A reference to a single secret by name. Resolved to an ephemeral value by the
 * gateway at dispatch. Carries no value and has no index signature, so a value
 * cannot be smuggled through structural typing.
 */
export interface CredentialReference {
  /** Distinguisher so a reference is never mistaken for a resolved credential. */
  readonly kind: 'credential-ref'
  /** The secret's name in the gateway secret store; never the value. */
  readonly secretName: string
  /** Optional credential-set field this reference satisfies. */
  readonly field?: string
}

/**
 * A credential-backed connection identity. Holds references only: the set of
 * secret refs that authenticate this connection, plus non-secret metadata. The
 * gateway resolves `credentials` to ephemeral values at dispatch.
 */
export interface Connection {
  /** Stable connection id assigned by the gateway/operator. */
  readonly id: string
  /** Which integration this connection is for (e.g. `slack`). */
  readonly integrationId: string
  /** The credential schema id this connection satisfies. */
  readonly credentialSchemaId: string
  /** Secret references that back this connection. Never values. */
  readonly credentials: readonly CredentialReference[]
  /** Non-secret connection metadata (workspace id, base url, …). */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}

/** Type guard for {@link CredentialReference}. */
export function isCredentialReference(value: unknown): value is CredentialReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'credential-ref' &&
    typeof (value as { secretName?: unknown }).secretName === 'string'
  )
}

/** Field names that, if present with a non-undefined value, indicate a leaked secret. */
const FORBIDDEN_VALUE_KEYS = ['value', 'secret', 'token', 'password', 'apiKey', 'accessToken']

/**
 * Runtime guard for a system boundary: assert that an object claiming to be a
 * credential reference does not also carry a resolved secret value. Throws when
 * any forbidden value-bearing key is present so a leaked value cannot flow past
 * the boundary. Compile-time the {@link CredentialReference} type already
 * forbids these keys; this catches `unknown`-typed input at runtime.
 */
export function assertNoSecretValue(value: unknown, context = 'credential reference'): void {
  if (typeof value !== 'object' || value === null) return
  for (const key of FORBIDDEN_VALUE_KEYS) {
    if ((value as Record<string, unknown>)[key] !== undefined) {
      throw new Error(
        `${context} must not carry a secret value (offending field: "${key}"); use a secretName reference instead`,
      )
    }
  }
}
