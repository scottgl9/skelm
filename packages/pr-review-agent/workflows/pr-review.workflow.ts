/**
 * `@skelm/pr-review-agent` default workflow.
 *
 * Given a PR ref (provider + repo + number) it fetches PR data through the
 * GitHub adapter (credential resolved from a secret reference), runs the
 * native `@skelm/agent` backend over the diff to produce findings, verifies
 * follow-up commits against prior findings, and — only when the project
 * profile's safe-write mode and the credential write grant both allow — posts
 * the review.
 *
 * Default-deny: with no `GITHUB_REVIEW_WRITE_TOKEN` secret and no profile that
 * opts into writing, the agent is read-only. Posting is a network egress the
 * gateway enforces and audits; this package adds no second audit writer.
 *
 * The agent backend is supplied by the host skelm config (`backends.agent`),
 * which must be a native `@skelm/agent` backend. The egress to the LLM and to
 * GitHub is mediated by the gateway under the declared permissions.
 */

import { agent, code, pipeline } from '@skelm/core'
import {
  GitHubReviewAdapter,
  buildReviewPrompt,
  clampEvent,
  classifyReview,
  resolveProfile,
  reviewOutputSchema,
  verifyFollowUp,
} from '@skelm/pr-review-agent'
import type {
  Finding,
  PrData,
  PrRef,
  ProfileConfigInput,
  ReviewEvent,
  ReviewResult,
} from '@skelm/pr-review-agent'
import { z } from 'zod'

const ChangedFileSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'removed', 'renamed']),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().optional(),
  previousPath: z.string().optional(),
})

export const PrReviewInputSchema = z.object({
  provider: z.literal('github').default('github'),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  /** Profile id to use; falls back to the config default profile. */
  profileId: z.string().optional(),
  /** Findings carried from a prior run, for follow-up verification. */
  priorFindings: z
    .array(
      z.object({
        path: z.string(),
        line: z.number().int().positive().optional(),
        severity: z.enum(['info', 'warning', 'error']),
        message: z.string(),
        ruleId: z.string().optional(),
      }),
    )
    .default([]),
})

export type PrReviewInput = z.infer<typeof PrReviewInputSchema>

/**
 * Project / provider profiles. Override by editing this constant when the
 * package is installed, or surface it through package config. Read-only
 * (`safeWrite.mode: 'off'`) until an operator opts a profile into writing.
 */
const PROFILE_CONFIG: ProfileConfigInput = {
  defaultProfile: 'default',
  profiles: [
    {
      id: 'default',
      reviewStyle:
        'Review for correctness, security, and clarity. Flag bugs, missing error ' +
        'handling, and unsafe patterns. Reference files and lines. Be concise.',
    },
  ],
}

/** Build a read-only-or-writable GitHub adapter from the resolved secret. */
function buildAdapter(token: string | undefined): GitHubReviewAdapter {
  return new GitHubReviewAdapter({
    ...(token !== undefined && { token, canWrite: true }),
  })
}

export default pipeline({
  id: 'default',
  description:
    'Fetch a PR, classify first-vs-follow-up, produce findings, optionally post a review.',
  input: PrReviewInputSchema,
  steps: [
    code({
      id: 'fetch-pr',
      // Read-only fetch needs network egress to the provider API + the
      // credential reference (resolved by the gateway, never embedded).
      secrets: ['GITHUB_REVIEW_TOKEN'],
      permissions: {
        allowedSecrets: ['GITHUB_REVIEW_TOKEN'],
        networkEgress: { allowHosts: ['api.github.com'] },
      },
      run: async (ctx): Promise<{ pr: PrData; kind: ReturnType<typeof classifyReview> }> => {
        const input = ctx.input as PrReviewInput
        const ref: PrRef = {
          provider: 'github',
          owner: input.owner,
          repo: input.repo,
          number: input.number,
        }
        const token = ctx.secrets?.get('GITHUB_REVIEW_TOKEN')
        const adapter = new GitHubReviewAdapter({ ...(token !== undefined && { token }) })
        const pr = await adapter.fetchPrData(ref)
        return { pr, kind: classifyReview(pr) }
      },
    }),

    agent({
      id: 'review',
      backend: 'agent',
      // Read-only analysis: no tools, no fs, no exec. networkEgress only to the
      // LLM endpoint, mediated by the gateway proxy. Tighten/extend per profile.
      permissions: {
        allowedTools: [],
        allowedExecutables: [],
        allowedMcpServers: [],
        allowedSkills: [],
        fsRead: [],
        fsWrite: [],
        networkEgress: 'allow',
      },
      prompt: (ctx) => {
        const input = ctx.input as PrReviewInput
        const fetched = ctx.get<{ pr: PrData; kind: ReturnType<typeof classifyReview> }>('fetch-pr')
        if (fetched === undefined) throw new Error('fetch-pr step produced no output')
        const profile = resolveProfile(PROFILE_CONFIG, input.profileId)
        return buildReviewPrompt({
          pr: fetched.pr,
          kind: fetched.kind,
          profile,
          priorFindings: input.priorFindings as readonly Finding[],
        })
      },
      output: reviewOutputSchema,
      maxTurns: 1,
      timeoutMs: 120_000,
    }),

    code({
      id: 'post',
      secrets: ['GITHUB_REVIEW_WRITE_TOKEN'],
      permissions: {
        allowedSecrets: ['GITHUB_REVIEW_WRITE_TOKEN'],
        networkEgress: { allowHosts: ['api.github.com'] },
      },
      run: async (ctx): Promise<ReviewResult> => {
        const input = ctx.input as PrReviewInput
        const ref: PrRef = {
          provider: 'github',
          owner: input.owner,
          repo: input.repo,
          number: input.number,
        }
        const fetched = ctx.get<{ pr: PrData }>('fetch-pr')
        if (fetched === undefined) throw new Error('fetch-pr step produced no output')
        const pr = fetched.pr
        const out = ctx.get<z.output<typeof reviewOutputSchema>>('review')
        if (out === undefined) throw new Error('review step produced no output')

        const profile = resolveProfile(PROFILE_CONFIG, input.profileId)
        const kind = classifyReview(pr)
        const priorFindings = input.priorFindings as readonly Finding[]
        const followUp = kind === 'follow-up' ? verifyFollowUp(pr, priorFindings) : []
        const event: ReviewEvent = clampEvent(out.recommendedEvent, profile, pr)
        const draft = { event, summary: out.summary, findings: out.findings as readonly Finding[] }

        if (profile.safeWrite.mode === 'off') {
          return {
            ref,
            kind,
            draft,
            followUp,
            posted: false,
            postSkippedReason: 'profile safe-write mode is off (read-only)',
          }
        }
        // A write needs an explicit write credential. Missing => read-only.
        const writeToken = ctx.secrets?.get('GITHUB_REVIEW_WRITE_TOKEN')
        const adapter = buildAdapter(writeToken)
        if (!adapter.canWrite) {
          return {
            ref,
            kind,
            draft,
            followUp,
            posted: false,
            postSkippedReason: 'no write credential (GITHUB_REVIEW_WRITE_TOKEN) granted',
          }
        }
        const { url } = await adapter.postReview(ref, draft)
        return { ref, kind, draft, followUp, posted: true, postedUrl: url }
      },
    }),
  ],
  finalize: (ctx): ReviewResult => {
    const result = ctx.get<ReviewResult>('post')
    if (result === undefined) throw new Error('post step produced no output')
    return result
  },
})
