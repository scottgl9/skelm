/**
 * The Notion liveness primitive: GET /v1/users/me. Returns the authenticated
 * bot/user object so a health check or live test can confirm the token works
 * without exposing the token itself.
 */

import type { NotionUser } from './actions.js'
import type { NotionClient } from './client.js'

/** Fetch the integration's own bot/user record (GET /v1/users/me). */
export function getCurrentUser(client: NotionClient): Promise<NotionUser> {
  return client.request<NotionUser>({ method: 'GET', path: '/v1/users/me' })
}
