// Vault SecretResolver — M4 seam.
//
// Reserves the public shape so a HashiCorp Vault driver lands as a pure
// addition. Every method throws NotImplementedError; production callers
// keep using EnvSecretResolver (default) or FileSecretResolver
// (file-backed local development).
//
// Locking the constructor signature here means consumers can write
// `new VaultSecretResolver({ url, token, mount })` against the seam
// today; M4 swaps in the real driver without breaking call sites.

import type { SecretResolver } from '@skelm/core'

export interface VaultSecretResolverOptions {
  /** Vault server URL, e.g. https://vault.internal:8200 */
  readonly url: string
  /** Auth token. Production wires this from a short-lived credential. */
  readonly token: string
  /**
   * KV v2 mount path; defaults to `secret`. Reserved on the seam so
   * deployments with custom mounts don't have to migrate later.
   */
  readonly mount?: string
  /**
   * Secret-name prefix applied before every lookup (e.g. `skelm/`).
   * Useful for namespacing per environment.
   */
  readonly prefix?: string
}

export class VaultNotImplementedError extends Error {
  override readonly name = 'VaultNotImplementedError'
  constructor() {
    super(
      'VaultSecretResolver is reserved for M4 — use FileSecretResolver or ' +
        'EnvSecretResolver until the driver lands',
    )
  }
}

/**
 * @experimental Reserved skeleton for the M4 Vault driver. Throws
 * VaultNotImplementedError on resolve. Do not depend on this in
 * production code.
 */
export class VaultSecretResolver implements SecretResolver {
  constructor(readonly options: VaultSecretResolverOptions) {
    void this.options
  }

  async resolve(_name: string): Promise<string | undefined> {
    throw new VaultNotImplementedError()
  }
}
