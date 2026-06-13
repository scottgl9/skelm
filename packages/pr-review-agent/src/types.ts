/**
 * Domain types for `@skelm/pr-review-agent`.
 *
 * Provider-agnostic shapes: a PR reference, the data fetched for a PR, a
 * review finding anchored to a file/line, and the review decision. GitHub is
 * the only provider with a concrete adapter today, but nothing here is GitHub-
 * specific — a new provider implements {@link PrReviewAdapter} and feeds the
 * same shapes into the review flow.
 */

/** Supported review providers. GitHub first. */
export type PrProvider = 'github'

/**
 * A reference that uniquely identifies a pull request: provider + repo
 * coordinates + number. The credential used to fetch/post is referenced by
 * name only ({@link PrReviewAdapter} resolves the value), never embedded here.
 */
export interface PrRef {
  readonly provider: PrProvider
  readonly owner: string
  readonly repo: string
  readonly number: number
}

/** A single changed file in the PR diff. */
export interface ChangedFile {
  readonly path: string
  readonly status: 'added' | 'modified' | 'removed' | 'renamed'
  readonly additions: number
  readonly deletions: number
  /** Unified-diff patch for this file, when GitHub returns one. */
  readonly patch?: string
  readonly previousPath?: string
}

/** A prior review left on the PR. */
export interface PriorReview {
  readonly id: number
  readonly author: string
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  readonly submittedAt?: string
  readonly body?: string
}

/** A commit on the PR head branch. */
export interface PrCommit {
  readonly sha: string
  readonly message: string
  readonly committedAt?: string
}

/** Aggregate CI / check status for the PR head. */
export interface CheckStatus {
  readonly name: string
  readonly status: 'queued' | 'in_progress' | 'completed'
  readonly conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'timed_out'
    | 'action_required'
    | 'skipped'
    | 'stale'
    | null
}

/** Everything the review flow needs about a PR. Fetched via the adapter. */
export interface PrData {
  readonly ref: PrRef
  readonly title: string
  readonly body: string
  readonly author: string
  readonly authorIsBot: boolean
  readonly headSha: string
  readonly baseSha: string
  readonly draft: boolean
  readonly labels: readonly string[]
  readonly changedFiles: readonly ChangedFile[]
  readonly commits: readonly PrCommit[]
  readonly reviews: readonly PriorReview[]
  readonly checks: readonly CheckStatus[]
}

/** Severity of a review finding. */
export type FindingSeverity = 'info' | 'warning' | 'error'

/**
 * A single review observation, anchored to a file and (when known) a line in
 * the head revision. `line` is omitted for file-level or PR-level findings.
 */
export interface Finding {
  readonly path: string
  readonly line?: number
  readonly severity: FindingSeverity
  readonly message: string
  /** Stable id used to match a follow-up commit against a prior finding. */
  readonly ruleId?: string
}

/** Whether this is the first review pass or a follow-up after prior reviews. */
export type ReviewKind = 'first-review' | 'follow-up'

/** Per-finding follow-up verdict produced by {@link verifyFollowUp}. */
export interface FollowUpVerification {
  readonly finding: Finding
  /** True when a commit after the prior review touched the finding's file. */
  readonly addressed: boolean
  /** SHAs of head commits that touched the finding's file post-review. */
  readonly addressingCommits: readonly string[]
}

/** What the agent decided to do with the PR. */
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'

/** A posted-or-pending review payload. */
export interface ReviewDraft {
  readonly event: ReviewEvent
  readonly summary: string
  readonly findings: readonly Finding[]
}

/** Outcome of a full review run. */
export interface ReviewResult {
  readonly ref: PrRef
  readonly kind: ReviewKind
  readonly draft: ReviewDraft
  readonly followUp: readonly FollowUpVerification[]
  /** True when a review/comment was actually posted to the provider. */
  readonly posted: boolean
  /** Provider URL of the posted review, when posted. */
  readonly postedUrl?: string
  /** Reason posting was skipped, when `posted` is false. */
  readonly postSkippedReason?: string
}
