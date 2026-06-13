/**
 * Provider-agnostic PR review adapter, plus a GitHub implementation built on
 * the `@skelm/integrations` GitHub REST helpers.
 *
 * Trust model:
 * - The adapter is constructed with credentials *resolved from a reference* by
 *   the gateway secret resolver. The workflow declares the secret name; the
 *   value reaches the adapter only at run time and is held privately here.
 * - `canWrite` defaults to `false`. The write methods (`postReview`) throw
 *   `PrReviewWriteDeniedError` unless the adapter was constructed read-only=false
 *   *and* a credential is present. This mirrors the default-deny posture: a
 *   missing/omitted write grant denies, it does not silently no-op.
 * - The credential value is never returned, logged, or placed in an error
 *   message. `redactSecret` exists so callers can scrub any incidental string.
 */

import {
  GitHubApiError,
  type GitHubAuth,
  githubFetch,
  postIssueComment,
  postPullRequestReview,
} from '@skelm/integrations'
import type {
  ChangedFile,
  CheckStatus,
  PrCommit,
  PrData,
  PrRef,
  PriorReview,
  ReviewDraft,
} from './types.js'

/** Thrown when a write is attempted without an explicit write grant. */
export class PrReviewWriteDeniedError extends Error {
  override readonly name = 'PrReviewWriteDeniedError'
  constructor(action: string) {
    super(
      `PR review write denied: ${action} requires write permission and a credential reference. The agent is read-only by default.`,
    )
  }
}

/**
 * The capabilities the review flow needs from a provider. Stubbed wholesale in
 * tests — no real network. Read methods are always available; `postReview` is
 * gated by the implementation's write grant.
 */
export interface PrReviewAdapter {
  /** Provider id, for diagnostics. */
  readonly provider: string
  /** True when this adapter may post to the provider. */
  readonly canWrite: boolean
  /** Fetch all PR data the flow needs. */
  fetchPrData(ref: PrRef): Promise<PrData>
  /**
   * Post the review draft. Throws {@link PrReviewWriteDeniedError} when the
   * adapter is read-only. Returns the posted review URL.
   */
  postReview(ref: PrRef, draft: ReviewDraft): Promise<{ url: string }>
}

/** Scrub a known secret value out of an arbitrary string. */
export function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return text
  return text.split(secret).join('[REDACTED]')
}

function formatBody(body: unknown): string {
  if (typeof body === 'string') return body
  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

const REVIEW_EVENT_TO_GITHUB = {
  COMMENT: 'COMMENT',
  APPROVE: 'APPROVE',
  REQUEST_CHANGES: 'REQUEST_CHANGES',
} as const

export interface GitHubReviewAdapterOptions {
  /**
   * Resolved GitHub token (from a secret ref). Omit for an anonymous read-only
   * adapter against public PRs — but writes then always deny.
   */
  readonly token?: string
  readonly apiBase?: string
  /**
   * Grant the adapter the ability to post. Default `false` (read-only). Even
   * when `true`, a missing token denies writes.
   */
  readonly canWrite?: boolean
}

/** GitHub implementation of {@link PrReviewAdapter}. */
export class GitHubReviewAdapter implements PrReviewAdapter {
  static readonly #pageSize = 100
  readonly provider = 'github'
  readonly #token?: string
  readonly #apiBase?: string
  readonly #writeGranted: boolean

  constructor(opts: GitHubReviewAdapterOptions) {
    if (opts.token !== undefined) this.#token = opts.token
    if (opts.apiBase !== undefined) this.#apiBase = opts.apiBase
    this.#writeGranted = opts.canWrite === true
  }

  get canWrite(): boolean {
    return this.#writeGranted && this.#token !== undefined
  }

  get #auth(): GitHubAuth {
    return {
      ...(this.#token !== undefined && { token: this.#token }),
      ...(this.#apiBase !== undefined && { apiBase: this.#apiBase }),
    } as GitHubAuth
  }

  async fetchPrData(ref: PrRef): Promise<PrData> {
    const base = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`
    try {
      const [pr, files, commits, reviews] = await Promise.all([
        githubFetch<GhPull>({ auth: this.#auth, method: 'GET', path: base }),
        this.#fetchPaginated<GhFile>(`${base}/files`),
        this.#fetchPaginated<GhCommit>(`${base}/commits`),
        this.#fetchPaginated<GhReview>(`${base}/reviews`),
      ])
      const checks = await this.#fetchChecks(ref, pr.head.sha)
      return mapPull(ref, pr, files, commits, reviews, checks)
    } catch (err) {
      throw this.#redactError(err)
    }
  }

  async #fetchChecks(ref: PrRef, sha: string): Promise<readonly CheckStatus[]> {
    try {
      const res = await githubFetch<{ check_runs: GhCheckRun[] }>({
        auth: this.#auth,
        method: 'GET',
        path: `/repos/${ref.owner}/${ref.repo}/commits/${sha}/check-runs`,
      })
      return res.check_runs.map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
      }))
    } catch {
      // Checks are advisory for the flow; a repo without the checks API
      // surfaces an empty set rather than failing the whole fetch.
      return []
    }
  }

  async #fetchPaginated<T>(path: string): Promise<T[]> {
    const items: T[] = []
    for (let page = 1; ; page += 1) {
      const res = await githubFetch<T[]>({
        auth: this.#auth,
        method: 'GET',
        path: `${path}?per_page=${GitHubReviewAdapter.#pageSize}&page=${page}`,
      })
      items.push(...res)
      if (res.length < GitHubReviewAdapter.#pageSize) return items
    }
  }

  async postReview(ref: PrRef, draft: ReviewDraft): Promise<{ url: string }> {
    if (!this.canWrite) throw new PrReviewWriteDeniedError('postReview')
    try {
      const event = REVIEW_EVENT_TO_GITHUB[draft.event]
      const comments = draft.findings
        .filter((f) => f.line !== undefined)
        .map((f) => ({
          path: f.path,
          line: f.line as number,
          body: `**${f.severity}**: ${f.message}`,
          side: 'RIGHT' as const,
        }))
      if (event === 'COMMENT' && comments.length === 0) {
        const res = await postIssueComment({
          auth: this.#auth,
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
          body: draft.summary,
        })
        return { url: res.htmlUrl }
      }
      const res = await postPullRequestReview({
        auth: this.#auth,
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        event,
        body: draft.summary,
        ...(comments.length > 0 && { comments }),
      })
      return { url: res.htmlUrl }
    } catch (err) {
      throw this.#redactError(err)
    }
  }

  #redactError(err: unknown): Error {
    if (err instanceof GitHubApiError) {
      return new GitHubApiError(
        err.status,
        err.method,
        redactSecret(err.path, this.#token),
        redactSecret(formatBody(err.body), this.#token),
      )
    }
    if (err instanceof Error) {
      err.message = redactSecret(err.message, this.#token)
      return err
    }
    return new Error(redactSecret(String(err), this.#token))
  }
}

interface GhPull {
  title: string
  body: string | null
  draft: boolean
  user: { login: string; type: string }
  head: { sha: string }
  base: { sha: string }
  labels: Array<{ name: string }>
}
interface GhFile {
  filename: string
  status: string
  additions: number
  deletions: number
  patch?: string
  previous_filename?: string
}
interface GhCommit {
  sha: string
  commit: { message: string; committer?: { date?: string } }
}
interface GhReview {
  id: number
  user: { login: string } | null
  state: string
  submitted_at?: string
  body?: string
}
interface GhCheckRun {
  name: string
  status: CheckStatus['status']
  conclusion: CheckStatus['conclusion']
}

function mapFileStatus(s: string): ChangedFile['status'] {
  if (s === 'added' || s === 'removed' || s === 'renamed') return s
  return 'modified'
}

function mapReviewState(s: string): PriorReview['state'] {
  if (
    s === 'APPROVED' ||
    s === 'CHANGES_REQUESTED' ||
    s === 'COMMENTED' ||
    s === 'DISMISSED' ||
    s === 'PENDING'
  ) {
    return s
  }
  return 'COMMENTED'
}

function mapPull(
  ref: PrRef,
  pr: GhPull,
  files: readonly GhFile[],
  commits: readonly GhCommit[],
  reviews: readonly GhReview[],
  checks: readonly CheckStatus[],
): PrData {
  const changedFiles: ChangedFile[] = files.map((f) => ({
    path: f.filename,
    status: mapFileStatus(f.status),
    additions: f.additions,
    deletions: f.deletions,
    ...(f.patch !== undefined && { patch: f.patch }),
    ...(f.previous_filename !== undefined && { previousPath: f.previous_filename }),
  }))
  const prCommits: PrCommit[] = commits.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    ...(c.commit.committer?.date !== undefined && { committedAt: c.commit.committer.date }),
  }))
  const priorReviews: PriorReview[] = reviews.map((r) => ({
    id: r.id,
    author: r.user?.login ?? '',
    state: mapReviewState(r.state),
    ...(r.submitted_at !== undefined && { submittedAt: r.submitted_at }),
    ...(r.body !== undefined && { body: r.body }),
  }))
  return {
    ref,
    title: pr.title,
    body: pr.body ?? '',
    author: pr.user.login,
    authorIsBot: pr.user.type === 'Bot',
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    draft: pr.draft,
    labels: pr.labels.map((l) => l.name),
    changedFiles,
    commits: prCommits,
    reviews: priorReviews,
    checks,
  }
}
