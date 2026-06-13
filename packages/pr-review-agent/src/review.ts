/**
 * The provider-agnostic PR review flow.
 *
 * `runReview` is pure orchestration over two injected collaborators — a
 * {@link PrReviewAdapter} (the provider transport) and a {@link ReviewModel}
 * (the LLM) — so it is exercised in tests with both stubbed and no real
 * network or model traffic.
 *
 * Flow:
 *   1. Fetch PR data via the adapter (credential held privately in the adapter).
 *   2. Classify first-review vs follow-up from prior non-bot reviews.
 *   3. Ask the model for findings + a recommended event, given the diff,
 *      profile review style, and (for follow-ups) the prior findings.
 *   4. Verify follow-up: for each prior finding, did a post-review commit touch
 *      its file?
 *   5. Decide the final event under the profile's safe-write ceiling and the
 *      adapter's write grant, then post only when allowed.
 */

import type { PrReviewAdapter } from './adapter.js'
import { resolveProfile } from './profiles.js'
import type { ProfileConfigInput, ReviewProfile } from './profiles.js'
import type {
  Finding,
  FollowUpVerification,
  PrData,
  PrRef,
  PriorReview,
  ReviewDraft,
  ReviewEvent,
  ReviewKind,
  ReviewResult,
} from './types.js'

/**
 * Minimal model surface the flow needs. The workflow entrypoint adapts the
 * native `@skelm/agent` backend to this; tests pass a deterministic stub.
 */
export interface ReviewModel {
  review(input: ReviewModelInput): Promise<ReviewModelOutput>
}

export interface ReviewModelInput {
  readonly pr: PrData
  readonly kind: ReviewKind
  readonly profile: ReviewProfile
  /** Findings carried over from the most recent prior review, for follow-ups. */
  readonly priorFindings: readonly Finding[]
}

export interface ReviewModelOutput {
  readonly summary: string
  readonly findings: readonly Finding[]
  /** The event the model recommends; clamped by the safe-write ceiling. */
  readonly recommendedEvent: ReviewEvent
}

export interface RunReviewOptions {
  readonly adapter: PrReviewAdapter
  readonly model: ReviewModel
  readonly ref: PrRef
  readonly profileConfig?: ProfileConfigInput
  readonly profileId?: string
  /**
   * Findings from a prior review run, when the caller tracks them across runs
   * (e.g. via `ctx.state`). Empty for a first review.
   */
  readonly priorFindings?: readonly Finding[]
  /** Audit sink invoked once if a write is actually posted. */
  readonly onAudit?: (entry: ReviewAuditEntry) => void | Promise<void>
}

/** Single audit record emitted on an external write. */
export interface ReviewAuditEntry {
  readonly action: 'pr-review.post'
  readonly provider: string
  readonly repo: string
  readonly number: number
  readonly event: ReviewEvent
  readonly findingCount: number
  readonly url: string
}

/**
 * Classify the review as a first pass or a follow-up. A PR is a follow-up once
 * it carries at least one submitted review from a non-bot reviewer; the agent's
 * own COMMENT-only passes and pending/dismissed reviews don't count.
 */
export function classifyReview(pr: PrData): ReviewKind {
  const substantive = pr.reviews.some(
    (r) =>
      (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED') &&
      r.submittedAt !== undefined,
  )
  return substantive ? 'follow-up' : 'first-review'
}

/** The most recent submitted prior review, if any. */
export function latestPriorReview(pr: PrData): PriorReview | undefined {
  const submitted = pr.reviews
    .filter((r) => r.submittedAt !== undefined)
    .sort((a, b) => (a.submittedAt as string).localeCompare(b.submittedAt as string))
  return submitted.at(-1)
}

/**
 * For each prior finding, decide whether a follow-up commit addressed it: a
 * commit committed after the latest prior review that touched the finding's
 * file counts as addressing. This is a heuristic signal, not a proof — it tells
 * the reviewer where to look, it does not auto-resolve findings.
 */
export function verifyFollowUp(
  pr: PrData,
  priorFindings: readonly Finding[],
): readonly FollowUpVerification[] {
  const last = latestPriorReview(pr)
  const since = last?.submittedAt
  const changedPaths = new Set(pr.changedFiles.map((f) => f.path))
  return priorFindings.map((finding) => {
    if (!changedPaths.has(finding.path)) {
      return { finding, addressed: false, addressingCommits: [] }
    }
    const addressing = pr.commits
      .filter((c) => since === undefined || (c.committedAt ?? '') > since)
      .map((c) => c.sha)
    return {
      finding,
      addressed: addressing.length > 0,
      addressingCommits: addressing,
    }
  })
}

/**
 * Clamp a model-recommended event to the profile's safe-write ceiling and CI
 * gate. `'off'` never produces a postable event (caller skips the post).
 */
export function clampEvent(
  recommended: ReviewEvent,
  profile: ReviewProfile,
  pr: PrData,
): ReviewEvent {
  const mode = profile.safeWrite.mode
  if (mode === 'off') return 'COMMENT'
  if (mode === 'comment') return 'COMMENT'
  if (mode === 'request-changes') {
    return recommended === 'REQUEST_CHANGES' ? 'REQUEST_CHANGES' : 'COMMENT'
  }
  // mode === 'approve' — full range, but never approve over red required checks.
  if (recommended === 'APPROVE' && profile.safeWrite.requireGreenChecks) {
    if (!requiredChecksGreen(pr, profile)) return 'COMMENT'
  }
  return recommended
}

function requiredChecksGreen(pr: PrData, profile: ReviewProfile): boolean {
  if (profile.requiredChecks.length === 0) return true
  return profile.requiredChecks.every((name) => {
    const check = pr.checks.find((c) => c.name === name)
    return check !== undefined && check.status === 'completed' && check.conclusion === 'success'
  })
}

/** Run the full review flow. Read-only unless the adapter has a write grant. */
export async function runReview(opts: RunReviewOptions): Promise<ReviewResult> {
  const profile = resolveProfile(opts.profileConfig, opts.profileId)
  const pr = await opts.adapter.fetchPrData(opts.ref)
  const kind = classifyReview(pr)
  const priorFindings = opts.priorFindings ?? []

  const modelOut = await opts.model.review({ pr, kind, profile, priorFindings })
  const followUp = kind === 'follow-up' ? verifyFollowUp(pr, priorFindings) : []

  const event = clampEvent(modelOut.recommendedEvent, profile, pr)
  const draft: ReviewDraft = {
    event,
    summary: modelOut.summary,
    findings: modelOut.findings,
  }

  if (profile.safeWrite.mode === 'off') {
    return {
      ref: opts.ref,
      kind,
      draft,
      followUp,
      posted: false,
      postSkippedReason: 'profile safe-write mode is off (read-only)',
    }
  }
  if (!opts.adapter.canWrite) {
    return {
      ref: opts.ref,
      kind,
      draft,
      followUp,
      posted: false,
      postSkippedReason: 'adapter has no write grant (missing write permission or credential)',
    }
  }

  const { url } = await opts.adapter.postReview(opts.ref, draft)
  await opts.onAudit?.({
    action: 'pr-review.post',
    provider: opts.adapter.provider,
    repo: `${opts.ref.owner}/${opts.ref.repo}`,
    number: opts.ref.number,
    event,
    findingCount: draft.findings.length,
    url,
  })
  return { ref: opts.ref, kind, draft, followUp, posted: true, postedUrl: url }
}
