/**
 * Registry-level browser provider.
 *
 * Implements `@skelm/integration-sdk`'s {@link BrowserProvider}: it adds provider
 * identity, category, credentials (none — a local browser needs no secret refs),
 * cost metadata, a health check, and exposes a {@link PlaywrightBrowserDriver} as
 * its `driver`. The driver structurally satisfies the SDK's `BrowserDriver`
 * mirror, so this provider is a valid `BrowserProvider` without depending on the
 * heavy `@skelm/agent` package.
 *
 * The gateway constructs the provider with the egress policy and owns lifecycle;
 * the provider holds no credentials and resolves no secrets.
 */

import type {
  BrowserDriver,
  BrowserProvider,
  CredentialReference,
  EgressPolicy,
  ProviderHealthCheck,
} from '@skelm/integration-sdk'

import { PlaywrightBrowserDriver } from './driver.js'
import type { PlaywrightLauncher } from './playwright-types.js'

export interface PlaywrightBrowserProviderOptions {
  /** Stable provider id (default `playwright`). */
  readonly id?: string
  /** Gateway-supplied egress hook. Required. */
  readonly egress: EgressPolicy
  /** Run headless (default true). */
  readonly headless?: boolean
  /** Injected launcher for tests; defaults to lazy `playwright-core`. */
  readonly launcher?: PlaywrightLauncher
}

export class PlaywrightBrowserProvider implements BrowserProvider {
  readonly id: string
  readonly category = 'browser' as const
  readonly credentials: readonly CredentialReference[] = []
  readonly headless: boolean
  readonly driver: BrowserDriver
  private readonly impl: PlaywrightBrowserDriver

  constructor(opts: PlaywrightBrowserProviderOptions) {
    this.id = opts.id ?? 'playwright'
    this.headless = opts.headless ?? true
    this.impl = new PlaywrightBrowserDriver({
      egress: opts.egress,
      headless: this.headless,
      ...(opts.launcher !== undefined ? { launcher: opts.launcher } : {}),
    })
    this.driver = this.impl
  }

  /**
   * Liveness check. Reports whether `playwright-core` is resolvable WITHOUT
   * launching a browser or downloading binaries — a launch attempt would require
   * an installed browser, which the default CI does not have.
   */
  async health(): Promise<ProviderHealthCheck> {
    const checkedAt = new Date().toISOString()
    try {
      await import('playwright-core')
      return { healthy: true, status: 'ok', checkedAt, detail: 'playwright-core resolvable' }
    } catch (err) {
      return {
        healthy: false,
        status: 'error',
        checkedAt,
        detail: `playwright-core not resolvable: ${err instanceof Error ? err.message : 'unknown'}`,
      }
    }
  }

  /** Underlying driver, for hosts that need lifecycle (`close`) or artifact capture. */
  get playwrightDriver(): PlaywrightBrowserDriver {
    return this.impl
  }
}
