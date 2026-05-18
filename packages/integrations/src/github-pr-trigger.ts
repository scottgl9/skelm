/**
 * `github-pr` trigger primitive.
 *
 * Wraps the gateway's `webhook` trigger + dedupe + integration event mapping
 * into a single declarative shape: a pipeline file declares
 *
 *   triggers: [{ kind: 'github-pr', path: '/hooks/gh-pr', events: [...], filter: {...} }]
 *
 * and `registerGitHubPrTrigger()` translates that into a webhook trigger on
 * the coordinator with `X-GitHub-Delivery` dedupe enabled and an onFire
 * wrapper that normalizes the GitHub webhook payload into a stable
 * `GitHubPrPayload` shape before dispatching the pipeline run.
 *
 * Filtering (dropBotAuthors, repos allowlist, event kinds) is applied
 * pre-dispatch; rejected deliveries respond 200 (so GitHub doesn't retry)
 * but don't fire the pipeline.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export type GitHubPrEventKind =
  | 'opened'
  | 'synchronize'
  | 'reopened'
  | 'closed'
  | 'review_requested'
  | 'commented'
  | 'submitted'

export interface GitHubPrTriggerSpec {
  /** Trigger id. Used by the coordinator's registration. */
  readonly id: string
  /** Workflow id this trigger fires. */
  readonly workflowId: string
  /** Webhook path the gateway should listen on (e.g. `/hooks/github/prs`). */
  readonly path: string
  /**
   * Optional HMAC shared secret. When set, the helper verifies GitHub's
   * `x-hub-signature-256` header against an HMAC of the raw body. Mismatches
   * raise a permission denial; missing headers raise an error.
   */
  readonly secret?: string
  /** Subset of GitHub PR-related event kinds to forward. Default: every kind below. */
  readonly events?: readonly GitHubPrEventKind[]
  /** Filters applied to the normalized payload before firing the pipeline. */
  readonly filter?: {
    readonly dropBotAuthors?: boolean
    readonly repos?: readonly string[]
  }
  /**
   * Dedupe TTL in milliseconds. Defaults to 24 h (matches GitHub's
   * redelivery window). The header is fixed to `X-GitHub-Delivery`.
   */
  readonly dedupeTtlMs?: number
}

export interface GitHubPrPayload {
  /** Normalized event kind. */
  readonly kind: GitHubPrEventKind
  /** PR identity + key fields needed for diff/review pipelines. */
  readonly pr: {
    readonly owner: string
    readonly repo: string
    readonly number: number
    readonly headSha: string
    readonly baseSha: string
    readonly author: string
    readonly labels: readonly string[]
  }
  /** Author classification. PR-review agents typically skip bot-authored PRs. */
  readonly authorIsBot: boolean
  /** Original GitHub event name (e.g. 'pull_request', 'issue_comment', …). */
  readonly githubEvent: string
  /** Original GitHub action (e.g. 'opened', 'synchronize', …). */
  readonly action: string
  /** Raw webhook payload, in case the pipeline needs fields beyond the normalized ones. */
  readonly raw: unknown
}

const ALL_EVENT_KINDS: readonly GitHubPrEventKind[] = [
  'opened',
  'synchronize',
  'reopened',
  'closed',
  'review_requested',
  'commented',
  'submitted',
]

/**
 * Translate a GitHub webhook delivery into the normalized payload, or null
 * when the delivery is not PR-related or fails the spec's filter.
 *
 * `githubEvent` is the value of the `x-github-event` header
 * (`pull_request`, `issue_comment`, `pull_request_review`,
 * `pull_request_review_comment`). The function inspects `body.action` and
 * the PR fields to map onto `GitHubPrEventKind`.
 */
export function normalizeGitHubPrEvent(
  githubEvent: string,
  body: unknown,
  spec?: Pick<GitHubPrTriggerSpec, 'events' | 'filter'>,
): GitHubPrPayload | null {
  const b = body as Record<string, unknown> | null
  if (b === null || typeof b !== 'object') return null
  const action = typeof b.action === 'string' ? b.action : ''

  // Map (event, action) → kind. Reject events that aren't PR-related.
  const kind = mapKind(githubEvent, action, b)
  if (kind === null) return null

  // The PR object lives under different paths depending on the event:
  //  - pull_request:                 b.pull_request
  //  - pull_request_review:          b.pull_request
  //  - pull_request_review_comment:  b.pull_request
  //  - issue_comment (on a PR):      b.issue (with b.issue.pull_request set)
  const pr = (b.pull_request as Record<string, unknown> | undefined) ?? extractPrFromIssue(b)
  if (pr === undefined) return null

  const head = (pr.head as Record<string, unknown> | undefined) ?? {}
  const base = (pr.base as Record<string, unknown> | undefined) ?? {}
  const baseRepo = (base.repo as Record<string, unknown> | undefined) ?? {}
  const owner =
    ((baseRepo.owner as Record<string, unknown> | undefined)?.login as string | undefined) ?? ''
  const repo = (baseRepo.name as string | undefined) ?? ''
  const number = pr.number as number
  const headSha = (head.sha as string | undefined) ?? ''
  const baseSha = (base.sha as string | undefined) ?? ''
  const user = (pr.user as Record<string, unknown> | undefined) ?? {}
  const author = (user.login as string | undefined) ?? ''
  const authorIsBot = (user.type as string | undefined) === 'Bot'
  const labelsRaw = Array.isArray(pr.labels) ? (pr.labels as Record<string, unknown>[]) : []
  const labels = labelsRaw.map((l) => (l.name as string | undefined) ?? '').filter((s) => s !== '')

  const payload: GitHubPrPayload = {
    kind,
    pr: { owner, repo, number, headSha, baseSha, author, labels },
    authorIsBot,
    githubEvent,
    action,
    raw: body,
  }

  if (!passesFilter(payload, spec)) return null
  return payload
}

function mapKind(
  githubEvent: string,
  action: string,
  _body: Record<string, unknown>,
): GitHubPrEventKind | null {
  if (githubEvent === 'pull_request') {
    if (action === 'opened') return 'opened'
    if (action === 'synchronize') return 'synchronize'
    if (action === 'reopened') return 'reopened'
    if (action === 'closed') return 'closed'
    if (action === 'review_requested') return 'review_requested'
    return null
  }
  if (githubEvent === 'pull_request_review' && action === 'submitted') return 'submitted'
  if (githubEvent === 'pull_request_review_comment') return 'commented'
  if (githubEvent === 'issue_comment') return 'commented'
  return null
}

function extractPrFromIssue(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const issue = body.issue as Record<string, unknown> | undefined
  if (issue === undefined) return undefined
  if (issue.pull_request === undefined) return undefined
  return issue
}

function passesFilter(
  payload: GitHubPrPayload,
  spec?: Pick<GitHubPrTriggerSpec, 'events' | 'filter'>,
): boolean {
  const events = spec?.events ?? ALL_EVENT_KINDS
  if (!events.includes(payload.kind)) return false
  const filter = spec?.filter
  if (filter?.dropBotAuthors === true && payload.authorIsBot) return false
  if (filter?.repos !== undefined && filter.repos.length > 0) {
    const slug = `${payload.pr.owner}/${payload.pr.repo}`
    if (!filter.repos.includes(slug)) return false
  }
  return true
}

/**
 * Verify GitHub's `x-hub-signature-256` HMAC against the raw body. The
 * gateway's body parser may have already deserialized the body to JSON; we
 * canonicalize by stringifying the parsed JSON, which matches the form
 * GitHub computes the signature over only when no whitespace was preserved
 * in the original request. For exact verification operators should configure
 * a raw-body shim. This helper is opportunistic — it rejects clearly invalid
 * signatures but does not guarantee constant-time semantics on
 * already-parsed bodies.
 */
export function verifyGitHubSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature.startsWith('sha256=')) return false
  const provided = signature.slice('sha256='.length)
  const computed = createHmac('sha256', secret).update(rawBody).digest('hex')
  if (provided.length !== computed.length) return false
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(computed, 'hex'))
}

/**
 * Minimal coordinator surface the helper needs. Matches the public methods
 * of `gateway.managers.triggers` (TriggerCoordinator) so callers can pass
 * the manager directly without a wrapper type.
 */
export interface GitHubPrTriggerCoordinator {
  register(
    spec: {
      kind: 'webhook'
      id: string
      workflowId: string
      path: string
      method?: string
      secret?: string
      dedupe?: { header: string; ttlMs?: number }
    },
    overlap?: 'skip' | 'queue' | 'cancel',
    options?: { input?: unknown },
  ): unknown
  /**
   * Hook invoked when the trigger fires. The integration wraps the existing
   * coordinator-level `onFire` so the normalized payload reaches the run
   * dispatcher instead of the raw webhook envelope.
   */
  // We don't need to model setOnFire here — the gateway sets it once at
  // boot and the helper relies on the coordinator's standard fire path.
}

/**
 * Translate a declarative `GitHubPrTriggerSpec` into a registered webhook
 * trigger on the coordinator. Returns a `normalize()` function the caller
 * (typically the gateway's dispatcher) can apply to incoming webhook
 * payloads to produce the `GitHubPrPayload` the pipeline expects as input.
 *
 * The dispatcher is responsible for routing the normalized payload to the
 * pipeline's run; integrators usually do this by registering a
 * `pre-dispatch` hook that calls `normalize()` on the raw webhook envelope
 * captured in `payload.body`.
 */
export function registerGitHubPrTrigger(
  coordinator: GitHubPrTriggerCoordinator,
  spec: GitHubPrTriggerSpec,
): {
  normalize(rawWebhookPayload: {
    body: unknown
    headers: Record<string, string>
  }): GitHubPrPayload | null
} {
  coordinator.register({
    kind: 'webhook',
    id: spec.id,
    workflowId: spec.workflowId,
    path: spec.path,
    method: 'POST',
    ...(spec.secret !== undefined && { secret: spec.secret }),
    dedupe: { header: 'X-GitHub-Delivery', ttlMs: spec.dedupeTtlMs ?? 24 * 60 * 60 * 1000 },
  })
  return {
    normalize(rawWebhookPayload) {
      const event =
        rawWebhookPayload.headers['x-github-event'] ?? rawWebhookPayload.headers['X-GitHub-Event']
      if (typeof event !== 'string' || event === '') return null
      return normalizeGitHubPrEvent(event, rawWebhookPayload.body, spec)
    },
  }
}
