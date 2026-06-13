/**
 * Health and test contracts.
 *
 * Integration and provider packages expose these so the gateway, dashboard, and
 * skelm-self-test can check liveness and run mocked (default CI) and live
 * (env-gated) validation without external accounts in the default suite.
 */

/** Result of a provider/connection health check. */
export interface ProviderHealthCheck {
  readonly healthy: boolean
  /** Short machine status (`ok`, `unhealthy`, `error`). */
  readonly status: 'ok' | 'unhealthy' | 'error'
  /** ISO timestamp the check ran. */
  readonly checkedAt: string
  /** Non-secret diagnostic detail. Must not contain secret values. */
  readonly detail?: string
}

/**
 * A mock fixture an integration package ships for deterministic CI. The fixture
 * supplies canned inbound payloads and the adapter/provider factory the test
 * harness drives — never real credentials.
 */
export interface MockProviderFixture {
  /** Provider/integration id this fixture stands in for. */
  readonly provider: string
  readonly description?: string
  /** Canned raw provider payloads (webhooks, command events, …). */
  readonly payloads: Readonly<Record<string, unknown>>
}

/**
 * Descriptor for an opt-in live test. The test runs only when every env var in
 * `requiredEnv` is present; each name is conventionally `SKELM_LIVE_*` or a
 * provider credential env var. Live tests must clean up after themselves and
 * never post secrets.
 */
export interface LiveTestDescriptor {
  /** Provider/integration id the live test exercises. */
  readonly provider: string
  /** Human label for the live test section. */
  readonly name: string
  /**
   * Env vars that must all be present for the test to run; otherwise it is
   * skipped (never failed). The gating flag is conventionally `SKELM_LIVE_*`.
   */
  readonly requiredEnv: readonly string[]
  readonly description?: string
}

/**
 * Decide whether a live test should run. Returns true only when every name in
 * `descriptor.requiredEnv` is present and non-empty in `env`. Defaults to
 * `process.env`. Pure check — performs no I/O and reads no secret values.
 */
export function shouldRunLiveTest(
  descriptor: LiveTestDescriptor,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return descriptor.requiredEnv.every((name) => {
    const v = env[name]
    return typeof v === 'string' && v.length > 0
  })
}
