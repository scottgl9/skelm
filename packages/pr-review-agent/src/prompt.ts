/**
 * Prompt construction and structured-output parsing for the review model.
 *
 * Kept pure so both the model output schema and the prompt text are unit-
 * tested without a backend. The workflow entrypoint feeds `buildReviewPrompt`
 * to an `agent()` step with `reviewOutputSchema`, then maps the validated
 * result into a {@link ReviewModelOutput}.
 */

import { z } from 'zod'
import type { ReviewProfile } from './profiles.js'
import type { Finding, PrData, ReviewKind } from './types.js'

export const findingSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().min(1),
  ruleId: z.string().optional(),
})

export const reviewOutputSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(findingSchema).default([]),
  recommendedEvent: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']).default('COMMENT'),
})

export type ReviewOutput = z.output<typeof reviewOutputSchema>

const MAX_PATCH_CHARS = 6000

/** Build the review prompt from PR data, profile, and prior findings. */
export function buildReviewPrompt(input: {
  readonly pr: PrData
  readonly kind: ReviewKind
  readonly profile: ReviewProfile
  readonly priorFindings: readonly Finding[]
}): string {
  const { pr, kind, profile, priorFindings } = input
  const ignore = new Set(profile.ignorePaths)
  const files = pr.changedFiles.filter((f) => !ignore.has(f.path))

  const diffBlocks = files
    .map((f) => {
      const patch = f.patch === undefined ? '(no patch available)' : truncate(f.patch)
      return `### ${f.path} (${f.status}, +${f.additions}/-${f.deletions})\n${patch}`
    })
    .join('\n\n')

  const priorBlock =
    kind === 'follow-up' && priorFindings.length > 0
      ? `\nPrior findings to verify were addressed:\n${priorFindings
          .map((p) => `- [${p.severity}] ${p.path}${p.line ? `:${p.line}` : ''} — ${p.message}`)
          .join('\n')}\n`
      : ''

  const checksBlock =
    pr.checks.length > 0
      ? `\nCI checks:\n${pr.checks
          .map((c) => `- ${c.name}: ${c.status}${c.conclusion ? `/${c.conclusion}` : ''}`)
          .join('\n')}\n`
      : ''

  return [
    `You are reviewing pull request ${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}.`,
    `This is a ${kind}.`,
    profile.reviewStyle ? `Review style: ${profile.reviewStyle}` : '',
    `\nTitle: ${pr.title}`,
    pr.body ? `Description: ${pr.body}` : '',
    priorBlock,
    checksBlock,
    `\nChanged files:\n${diffBlocks || '(no changed files)'}`,
    '\nReply ONLY with JSON matching this schema:',
    '{"summary":"<one paragraph>","findings":[{"path":"<file>","line":<n?>,"severity":"info|warning|error","message":"<text>","ruleId":"<optional stable id>"}],"recommendedEvent":"COMMENT|APPROVE|REQUEST_CHANGES"}',
  ]
    .filter((s) => s !== '')
    .join('\n')
}

function truncate(patch: string): string {
  if (patch.length <= MAX_PATCH_CHARS) return patch
  return `${patch.slice(0, MAX_PATCH_CHARS)}\n… (patch truncated)`
}
