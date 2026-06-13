/**
 * Provider health check: `SELECT 1`. Returns a {@link ProviderHealthCheck} with
 * no secret values in `detail`.
 */

import type { ProviderHealthCheck } from '@skelm/integration-sdk'

import type { ExecutorProvider } from './types.js'

/** Run `SELECT 1` against the connection and report liveness. */
export async function checkHealth(provider: ExecutorProvider): Promise<ProviderHealthCheck> {
  const checkedAt = new Date().toISOString()
  try {
    const { executor, release } = await provider.acquire()
    try {
      const result = await executor.query<{ ok: number }>({ text: 'SELECT 1 AS ok' })
      const ok = result.rows[0]?.ok === 1
      return ok
        ? { healthy: true, status: 'ok', checkedAt }
        : { healthy: false, status: 'unhealthy', checkedAt, detail: 'SELECT 1 returned no row' }
    } finally {
      await release()
    }
  } catch {
    // No secret values: report only that the check failed, not why at value level.
    return { healthy: false, status: 'error', checkedAt, detail: 'health check failed' }
  }
}
