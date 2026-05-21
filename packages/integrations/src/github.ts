import { defineIntegration } from '@skelm/integration-sdk'
import type { GitHubIssueTrigger, GitHubWebhookEvent } from '@skelm/integration-sdk'
import { z } from 'zod'

const DEFAULT_API_BASE = 'https://api.github.com'
const SKELM_USER_AGENT = 'skelm-integrations/1.0'

const githubCredentialsSchema = z.object({
  token: z.string().min(1, 'GitHub token is required'),
  ownerId: z.string().min(1, 'GitHub ownerId is required'),
  repoName: z.string().min(1, 'GitHub repoName is required'),
  apiBase: z.string().url().optional(),
})

/**
 * Error raised by the GitHub REST helpers when an API call fails with a
 * non-2xx status. `status` is the HTTP status code; `body` is the parsed
 * JSON body if present, otherwise the raw text.
 */
export class GitHubApiError extends Error {
  override readonly name = 'GitHubApiError'
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`GitHub ${method} ${path} failed with ${status}: ${formatBody(body)}`)
  }
}

function formatBody(body: unknown): string {
  if (typeof body === 'string') return body
  if (body && typeof body === 'object' && 'message' in body) {
    return String((body as { message: unknown }).message)
  }
  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

/** Credentials accepted by the standalone REST helpers. */
export interface GitHubAuth {
  readonly token: string
  readonly apiBase?: string
}

interface GitHubRequest {
  readonly auth: GitHubAuth
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  readonly path: string
  readonly body?: unknown
  /** Per-request timeout in ms; default 30s. A hung GitHub edge cannot
   *  hold a gateway request handler indefinitely. */
  readonly timeoutMs?: number
}

const DEFAULT_GITHUB_TIMEOUT_MS = 30_000

/**
 * Make a JSON-bodied GitHub REST call. Returns the parsed JSON response;
 * throws `GitHubApiError` on non-2xx responses. Warns to stderr when the
 * remaining rate-limit budget drops below 10 % so operators see throttling
 * coming before it bites.
 */
export async function githubFetch<T = unknown>(req: GitHubRequest): Promise<T> {
  const base = req.auth.apiBase ?? DEFAULT_API_BASE
  const url = `${base}${req.path}`
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${req.auth.token}`,
    'User-Agent': SKELM_USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (req.body !== undefined) headers['Content-Type'] = 'application/json'
  const init: RequestInit = {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS),
    ...(req.body !== undefined && { body: JSON.stringify(req.body) }),
  }
  const res = await fetch(url, init)
  const remaining = Number(res.headers.get('x-ratelimit-remaining'))
  const limit = Number(res.headers.get('x-ratelimit-limit'))
  if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
    if (remaining / limit < 0.1) {
      process.stderr.write(
        `[github-integration] rate limit warning: ${remaining}/${limit} remaining for ${req.method} ${req.path}\n`,
      )
    }
  }
  const text = await res.text()
  const parsed = text.length > 0 ? safeJsonParse(text) : undefined
  if (!res.ok) {
    throw new GitHubApiError(res.status, req.method, req.path, parsed ?? text)
  }
  return parsed as T
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Verify a credential by calling `GET /user`. Returns true on 200. */
export async function getAuthenticatedUser(
  auth: GitHubAuth,
): Promise<{ login: string; id: number }> {
  return await githubFetch({ auth, method: 'GET', path: '/user' })
}

export interface RegisterWebhookParams {
  readonly auth: GitHubAuth
  readonly owner: string
  readonly repo: string
  readonly url: string
  readonly secret?: string
  readonly events?: readonly string[]
  readonly active?: boolean
}

export interface GitHubHook {
  readonly id: number
  readonly url: string
}

/** Register a webhook on `owner/repo`. Returns the created hook's id + url. */
export async function registerWebhook(params: RegisterWebhookParams): Promise<GitHubHook> {
  const body = {
    name: 'web',
    active: params.active ?? true,
    events: params.events ?? ['*'],
    config: {
      url: params.url,
      content_type: 'json',
      ...(params.secret !== undefined && { secret: params.secret }),
    },
  }
  const hook = await githubFetch<{ id: number; url: string }>({
    auth: params.auth,
    method: 'POST',
    path: `/repos/${params.owner}/${params.repo}/hooks`,
    body,
  })
  return { id: hook.id, url: hook.url }
}

export interface DeleteWebhookParams {
  readonly auth: GitHubAuth
  readonly owner: string
  readonly repo: string
  readonly hookId: number
}

export async function deleteWebhook(params: DeleteWebhookParams): Promise<void> {
  await githubFetch({
    auth: params.auth,
    method: 'DELETE',
    path: `/repos/${params.owner}/${params.repo}/hooks/${params.hookId}`,
  })
}

export interface PostIssueCommentParams {
  readonly auth: GitHubAuth
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly body: string
}

export async function postIssueComment(
  params: PostIssueCommentParams,
): Promise<{ id: number; htmlUrl: string }> {
  const res = await githubFetch<{ id: number; html_url: string }>({
    auth: params.auth,
    method: 'POST',
    path: `/repos/${params.owner}/${params.repo}/issues/${params.number}/comments`,
    body: { body: params.body },
  })
  return { id: res.id, htmlUrl: res.html_url }
}

export interface PullRequestReviewComment {
  readonly path: string
  readonly body: string
  /** Single-line comment (line in the diff hunk). */
  readonly line?: number
  /** Side of the diff: 'LEFT' for the base, 'RIGHT' for the head (default). */
  readonly side?: 'LEFT' | 'RIGHT'
  /** For multi-line comments: starting line in the same side. */
  readonly start_line?: number
  readonly start_side?: 'LEFT' | 'RIGHT'
}

export interface PostPullRequestReviewParams {
  readonly auth: GitHubAuth
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  readonly body?: string
  readonly comments?: readonly PullRequestReviewComment[]
  /** Commit SHA the review applies to. Defaults to the PR's current head. */
  readonly commitId?: string
}

/**
 * Post a pull request review (the call PR-review agents most need).
 *
 * `event` maps to GitHub's review action: APPROVE / REQUEST_CHANGES /
 * COMMENT. Body is the summary; per-line `comments` are inline review
 * comments anchored to the diff.
 */
export async function postPullRequestReview(
  params: PostPullRequestReviewParams,
): Promise<{ id: number; htmlUrl: string }> {
  const body: Record<string, unknown> = {
    event: params.event,
    ...(params.body !== undefined && { body: params.body }),
    ...(params.commitId !== undefined && { commit_id: params.commitId }),
    ...(params.comments !== undefined && { comments: params.comments }),
  }
  const res = await githubFetch<{ id: number; html_url: string }>({
    auth: params.auth,
    method: 'POST',
    path: `/repos/${params.owner}/${params.repo}/pulls/${params.number}/reviews`,
    body,
  })
  return { id: res.id, htmlUrl: res.html_url }
}

/**
 * GitHub integration for skelm pipelines.
 *
 * Supports:
 * - Issue/PR triggers
 * - Webhook event handling (real REST: POST /repos/:owner/:repo/hooks)
 * - Repository polling
 * - Notifications via issue/PR comments and PR reviews
 *
 * For PR-review pipelines, prefer the standalone `postPullRequestReview()`,
 * `postIssueComment()`, and `registerWebhook()` helpers — they accept a
 * `GitHubAuth` directly and do not require an integration instance.
 */
export const GitHubIntegration = defineIntegration({
  id: 'github',
  name: 'GitHub',

  capabilities: {
    canTrigger: true,
    canReceiveWebhooks: true,
    canPoll: true,
    canSendNotifications: true,
  },

  credentialsSchema: githubCredentialsSchema,

  async validateCredentials(_creds) {
    // Token-prefix sniffing produced false positives (fine-grained tokens,
    // GitHub Apps, enterprise issuers all use shapes that do not match
    // ghp_/gho_/github_). Validation now defers to performHealthCheck,
    // which makes a real API call.
  },

  async performHealthCheck(creds) {
    try {
      const auth: GitHubAuth = {
        token: creds.token,
        ...(creds.apiBase !== undefined && { apiBase: creds.apiBase }),
      }
      await getAuthenticatedUser(auth)
      return true
    } catch (err) {
      if (err instanceof GitHubApiError) return false
      throw err
    }
  },

  async setupWebhook(creds, config, webhook) {
    const auth: GitHubAuth = {
      token: creds.token,
      ...(creds.apiBase !== undefined && { apiBase: creds.apiBase }),
    }
    const hook = await registerWebhook({
      auth,
      owner: creds.ownerId,
      repo: creds.repoName,
      url: webhook.path,
      ...(webhook.secret !== undefined && { secret: webhook.secret }),
      events: webhook.events ?? ['*'],
    })
    // Persist the hook id on the webhook config so cleanupWebhook can use it.
    ;(webhook as { hookId?: number }).hookId = hook.id
  },

  async cleanupWebhook(creds, _config, webhook) {
    const hookId = (webhook as { hookId?: number }).hookId
    if (hookId === undefined) return
    const auth: GitHubAuth = {
      token: creds.token,
      ...(creds.apiBase !== undefined && { apiBase: creds.apiBase }),
    }
    await deleteWebhook({ auth, owner: creds.ownerId, repo: creds.repoName, hookId })
  },

  async eventToRunInput(event, creds) {
    const { event: eventType, payload } = event as GitHubWebhookEvent

    if (eventType === 'issues') {
      const p = payload as GitHubIssueTrigger
      return {
        trigger: {
          type: 'github-issue',
          event: eventType,
          action: p.action,
          owner: p.owner ?? creds.ownerId,
          repo: p.repo ?? creds.repoName,
          issueNumber: p.issueNumber,
          title: p.title,
          body: p.body,
          labels: p.labels,
        },
      }
    }

    if (eventType === 'pull_request') {
      return { trigger: { type: 'github-pr', event: eventType, payload } }
    }

    if (eventType === 'push') {
      return { trigger: { type: 'github-push', event: eventType, payload } }
    }

    return null
  },

  /**
   * Route a notification to the right REST call based on `options.kind`:
   *   - kind: 'issue-comment' (default) — POST /issues/:n/comments
   *   - kind: 'pr-review' — POST /pulls/:n/reviews (use `event`, optional `comments[]`)
   *
   * Both kinds require `options.number`. `pr-review` also accepts
   * `event` ('APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', default COMMENT) and
   * an optional `comments` array of inline review comments.
   */
  async sendNotification(message, options, creds) {
    const opts = (options ?? {}) as Record<string, unknown>
    const number = typeof opts.number === 'number' ? opts.number : undefined
    if (number === undefined) {
      throw new Error('GitHub sendNotification requires options.number (issue or PR number)')
    }
    const auth: GitHubAuth = {
      token: creds.token,
      ...(creds.apiBase !== undefined && { apiBase: creds.apiBase }),
    }
    const owner = typeof opts.owner === 'string' ? opts.owner : creds.ownerId
    const repo = typeof opts.repo === 'string' ? opts.repo : creds.repoName
    const kind = typeof opts.kind === 'string' ? opts.kind : 'issue-comment'

    if (kind === 'pr-review') {
      const eventRaw = typeof opts.event === 'string' ? opts.event : 'COMMENT'
      const event = eventRaw === 'APPROVE' || eventRaw === 'REQUEST_CHANGES' ? eventRaw : 'COMMENT'
      const comments = Array.isArray(opts.comments)
        ? (opts.comments as readonly PullRequestReviewComment[])
        : undefined
      await postPullRequestReview({
        auth,
        owner,
        repo,
        number,
        event,
        body: message,
        ...(comments !== undefined && { comments }),
      })
      return
    }

    await postIssueComment({ auth, owner, repo, number, body: message })
  },
})

// Keep the type alias so callers can do `new GitHubIntegration(config)` and
// also reference `typeof GitHubIntegration` for type narrowing.
export type GitHubIntegrationType = InstanceType<typeof GitHubIntegration>
