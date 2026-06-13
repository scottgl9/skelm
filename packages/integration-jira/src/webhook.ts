/**
 * Jira issue triggers.
 *
 * Jira Cloud's REST-registered dynamic webhooks are NOT signed by default — the
 * platform offers no shared HMAC secret on the standard webhook surface. So the
 * default, reliable trigger here is JQL-cursor polling (see
 * {@link buildPollJql}); a webhook path is offered for deployments that front
 * Jira with a proxy or use Atlassian automation able to attach a shared secret,
 * in which case {@link verifyJiraWebhook} performs constant-time HMAC
 * verification before the payload is normalized.
 */

import { type EventEnvelope, normalizeWebhook, verifyHmacSignature } from '@skelm/integration-sdk'

export const JIRA_SOURCE = 'jira'

/** Jira issue webhook event types this integration recognizes. */
export const JIRA_ISSUE_EVENTS = [
  'jira:issue_created',
  'jira:issue_updated',
  'jira:issue_deleted',
] as const

export type JiraIssueEventType = (typeof JIRA_ISSUE_EVENTS)[number]

export interface JiraWebhookPayload {
  readonly webhookEvent?: string
  readonly issue?: { readonly id?: string; readonly key?: string; readonly self?: string }
  readonly timestamp?: number
  readonly [k: string]: unknown
}

export interface VerifyJiraWebhookParams {
  /** Raw request body exactly as received. */
  readonly payload: string
  /** Signature header value the proxy/automation attached. */
  readonly signature: string
  /** Shared signing secret, resolved by the gateway. */
  readonly secret: string
  /** Digest prefix, when the sender uses one (e.g. `sha256=`). */
  readonly prefix?: string
}

/**
 * Constant-time HMAC-SHA256 verification of an optionally-signed Jira webhook.
 * Returns false on any mismatch. Callers must verify before normalizing; an
 * unsigned Jira deployment should rely on polling instead of this path.
 */
export function verifyJiraWebhook(params: VerifyJiraWebhookParams): boolean {
  return verifyHmacSignature({
    payload: params.payload,
    signature: params.signature,
    secret: params.secret,
    algorithm: 'sha256',
    ...(params.prefix !== undefined ? { prefix: params.prefix } : {}),
  })
}

/**
 * Normalize a verified Jira webhook body into an {@link EventEnvelope}. The
 * stable event id prefers the issue id + timestamp; absent those, the SDK
 * derives one from the payload so idempotency still holds.
 */
export function normalizeJiraWebhook(body: JiraWebhookPayload): EventEnvelope<JiraWebhookPayload> {
  const type = body.webhookEvent ?? 'jira:unknown'
  const issueId = body.issue?.id
  const id =
    issueId !== undefined && body.timestamp !== undefined
      ? `${issueId}:${body.timestamp}`
      : undefined
  return normalizeWebhook<JiraWebhookPayload>({
    source: JIRA_SOURCE,
    type,
    ...(id !== undefined ? { id } : {}),
    payload: body,
    ...(body.timestamp !== undefined ? { receivedAt: body.timestamp } : {}),
  })
}

/**
 * Build the JQL used for cursor polling. Returns issues updated at or after
 * `sinceEpochMs`, ordered by update time ascending so the caller can advance a
 * watermark cursor. The JQL `updated` clause uses minute granularity, so the
 * caller should overlap-and-dedupe (via the SDK `IdempotencyTracker`) rather
 * than assume exact-millisecond cursors.
 */
export function buildPollJql(projectKey: string, sinceEpochMs: number): string {
  const minute = Math.floor(sinceEpochMs / 60_000) * 60_000
  return `project = "${projectKey}" AND updated >= ${minute} ORDER BY updated ASC`
}
