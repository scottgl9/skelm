import { defineIntegration } from '@skelm/integration-sdk'
import { z } from 'zod'

/**
 * Microsoft Graph integration for skelm pipelines.
 *
 * Built around the Graph change-notification webhook flow:
 *   1. Graph posts a one-shot validation request with `?validationToken=…`;
 *      the gateway echoes the token verbatim within 10 seconds. See
 *      `getMsGraphValidationToken()`.
 *   2. After the subscription is live, Graph POSTs change notifications
 *      whose body is `{ value: [{ subscriptionId, clientState, resource,
 *      changeType, resourceData, ... }] }`. Verify the embedded
 *      `clientState` matches the secret stored at subscription time using
 *      `verifyMsGraphClientState()`.
 *
 * The integration declares `canReceiveWebhooks` but does not register the
 * subscription with Graph itself — that's deployment-specific and best done
 * by the pipeline owning the lifecycle.
 */
const msGraphCredentialsSchema = z.object({
  /** Azure AD tenant id (used by the pipeline for outbound Graph calls). */
  tenantId: z.string().min(1, 'Microsoft Graph tenantId is required'),
  /** Azure AD app/client id. */
  clientId: z.string().min(1, 'Microsoft Graph clientId is required'),
  /**
   * Shared `clientState` value the subscription was created with. Echoed
   * back by Graph on every notification; rejecting mismatches blocks
   * spoofed callers from your webhook URL.
   */
  clientState: z.string().min(1, 'Microsoft Graph clientState is required'),
})

export const MsGraphIntegration = defineIntegration({
  id: 'ms-graph',
  name: 'Microsoft Graph',

  capabilities: {
    canTrigger: true,
    canReceiveWebhooks: true,
    canPoll: false,
    canSendNotifications: false,
  },

  credentialsSchema: msGraphCredentialsSchema,

  async performHealthCheck(creds) {
    return (
      typeof creds.tenantId === 'string' &&
      creds.tenantId.length > 0 &&
      typeof creds.clientId === 'string' &&
      creds.clientId.length > 0
    )
  },

  async eventToRunInput(event, creds) {
    const body = event as { value?: unknown }
    if (!Array.isArray(body.value) || body.value.length === 0) return null
    const valid = body.value.filter((n) => verifyMsGraphClientState(n, creds.clientState))
    if (valid.length === 0) return null
    return { notifications: valid }
  },
})

/**
 * Pull the Microsoft Graph subscription validation token from a request URL
 * if present. Graph sends a GET (or POST) to the webhook URL with a
 * `validationToken` query parameter and expects the raw token echoed back
 * within 10 seconds with `Content-Type: text/plain`.
 */
export function getMsGraphValidationToken(url: string): string | null {
  try {
    const parsed = new URL(url, 'http://127.0.0.1')
    const token = parsed.searchParams.get('validationToken')
    return token === null || token === '' ? null : token
  } catch {
    return null
  }
}

/**
 * Verify that a Graph change notification's embedded `clientState` matches
 * the expected secret. Notifications without a `clientState` are rejected;
 * Graph always includes one when the subscription was created with it set.
 */
export function verifyMsGraphClientState(notification: unknown, expected: string): boolean {
  if (notification === null || typeof notification !== 'object') return false
  const cs = (notification as { clientState?: unknown }).clientState
  return typeof cs === 'string' && cs === expected
}

export type MsGraphIntegrationType = InstanceType<typeof MsGraphIntegration>
