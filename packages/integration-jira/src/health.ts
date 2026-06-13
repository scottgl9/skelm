import type { ProviderHealthCheck } from '@skelm/integration-sdk'
import { getMyself } from './actions.js'
import type { JiraClient } from './client.js'
import { JiraApiError } from './errors.js'

/**
 * Liveness + credential check via GET /myself. Never surfaces a secret value:
 * `detail` carries only the account id / display name or a status string.
 */
export async function checkJiraHealth(client: JiraClient): Promise<ProviderHealthCheck> {
  const checkedAt = new Date().toISOString()
  try {
    const me = await getMyself(client)
    return {
      healthy: true,
      status: 'ok',
      checkedAt,
      detail: `authenticated as ${me.displayName ?? me.accountId}`,
    }
  } catch (err) {
    if (err instanceof JiraApiError) {
      return {
        healthy: false,
        status: err.status === 401 || err.status === 403 ? 'unhealthy' : 'error',
        checkedAt,
        detail: `Jira /myself returned ${err.status}`,
      }
    }
    return {
      healthy: false,
      status: 'error',
      checkedAt,
      detail: err instanceof Error ? err.name : 'unknown error',
    }
  }
}
