/**
 * @skelm/pr-review-agent — project-agnostic PR review workflow package.
 *
 * Fetch a PR via a provider adapter (GitHub first), classify first-review vs
 * follow-up, produce findings with file/line references, verify whether
 * follow-up commits addressed prior findings, and — only when granted write
 * permission + a credential reference — post a safe, profile-gated review.
 *
 * Read-only by default. Posting is gated by both the project profile's
 * safe-write mode and the adapter's write grant; every external write is
 * audited through the gateway's single audit writer.
 */

export type {
  ChangedFile,
  CheckStatus,
  Finding,
  FindingSeverity,
  FollowUpVerification,
  PrCommit,
  PrData,
  PrProvider,
  PrRef,
  PriorReview,
  ReviewDraft,
  ReviewEvent,
  ReviewKind,
  ReviewResult,
} from './types.js'

export {
  GitHubReviewAdapter,
  PrReviewWriteDeniedError,
  redactSecret,
} from './adapter.js'
export type { GitHubReviewAdapterOptions, PrReviewAdapter } from './adapter.js'

export {
  DEFAULT_PROFILE,
  profileConfigSchema,
  resolveProfile,
  reviewProfileSchema,
  safeWriteModeSchema,
} from './profiles.js'
export type {
  ProfileConfig,
  ProfileConfigInput,
  ReviewProfile,
  ReviewProfileInput,
  SafeWriteMode,
} from './profiles.js'

export { buildReviewPrompt, findingSchema, reviewOutputSchema } from './prompt.js'
export type { ReviewOutput } from './prompt.js'

export {
  classifyReview,
  clampEvent,
  latestPriorReview,
  runReview,
  verifyFollowUp,
} from './review.js'
export type {
  ReviewAuditEntry,
  ReviewModel,
  ReviewModelInput,
  ReviewModelOutput,
  RunReviewOptions,
} from './review.js'
