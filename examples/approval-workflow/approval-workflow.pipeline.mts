import { branch, code, pipeline, wait } from '@skelm/core'
import { z } from 'zod'

/**
 * Expense approval workflow — human-in-the-loop pattern.
 *
 * Demonstrates: wait(), branch(), auto-approve fast path, resume via HTTP.
 *
 * Flow:
 *   1. Validate the expense request.
 *   2. Auto-approve expenses under $100 (no human review needed).
 *   3. For larger amounts: pause at a wait() step until a manager resumes
 *      the run with their decision.
 *   4. Branch on the decision → approved or rejected output.
 *
 * Run:
 *   skelm gateway start
 *   # Start the run (returns a runId and enters waiting state):
 *   curl -s http://127.0.0.1:14738/pipelines/approval-workflow.pipeline.ts/start \
 *     -H 'Content-Type: application/json' \
 *     -d '{"input":{"employeeName":"Alice","amount":350,"category":"Travel","description":"Flight to customer site"}}'
 *
 *   # Resume with a decision (replace <runId>):
 *   curl -s http://127.0.0.1:14738/runs/<runId>/resume \
 *     -H 'Content-Type: application/json' \
 *     -d '{"output":{"decision":"approve","comments":"Pre-approved by policy"}}'
 *
 * Or run directly (auto-approve path, amount < 100):
 *   skelm run approval-workflow.pipeline.ts \
 *     --input '{"employeeName":"Bob","amount":45,"category":"Meals","description":"Team lunch"}'
 */

export const ApprovalInputSchema = z.object({
  employeeName: z.string().min(1),
  amount: z.number().positive(),
  category: z.string().min(1),
  description: z.string(),
})

export const ApprovalOutputSchema = z.object({
  status: z.enum(['approved', 'rejected', 'invalid']),
  reviewerComments: z.string(),
  finalAmount: z.number(),
  autoApproved: z.boolean(),
})

export type ApprovalInput = z.infer<typeof ApprovalInputSchema>

/** Amounts below this threshold are auto-approved without human review. */
const AUTO_APPROVE_THRESHOLD = 100

export default pipeline({
  id: 'approval-workflow',
  description: 'Expense approval with optional human-in-the-loop review via wait().',
  input: ApprovalInputSchema,
  output: ApprovalOutputSchema,
  steps: [
    // Step 1: Validate the request.
    code({
      id: 'validate',
      run: (ctx) => {
        const { amount, category } = ctx.input as ApprovalInput
        if (amount <= 0) return { valid: false, reason: 'Amount must be positive' }
        if (!category.trim()) return { valid: false, reason: 'Category is required' }
        return { valid: true, reason: '' }
      },
    }),

    // Step 2: Reject immediately if invalid.
    branch({
      id: 'validation-gate',
      on: (ctx) => ((ctx.steps.validate as { valid: boolean }).valid ? 'valid' : 'invalid'),
      cases: {
        valid: code({ id: 'validation-ok', run: () => ({ passed: true }) }),
        invalid: code({
          id: 'validation-fail',
          run: (ctx) => ({
            passed: false,
            reason: (ctx.steps.validate as { reason: string }).reason,
          }),
        }),
      },
    }),

    // Step 3: Check for auto-approve.
    code({
      id: 'prepare-review',
      run: (ctx) => {
        const { employeeName, amount, category, description } = ctx.input as ApprovalInput
        const needsReview = amount >= AUTO_APPROVE_THRESHOLD
        return {
          needsReview,
          autoDecision: needsReview ? undefined : 'approve',
          summary: `${employeeName} — $${amount} (${category}): ${description}`,
        }
      },
    }),

    // Step 4: Skip wait() for small amounts; otherwise pause for human review.
    branch({
      id: 'auto-approve-gate',
      on: (ctx) =>
        (ctx.steps['prepare-review'] as { needsReview: boolean }).needsReview
          ? 'needs-review'
          : 'auto',
      cases: {
        auto: code({
          id: 'auto-approved',
          run: () => ({
            decision: 'approve',
            comments: 'Auto-approved (below threshold)',
            wasAuto: true,
          }),
        }),
        'needs-review': wait({
          id: 'human-review',
          message: 'Review this expense request and approve or reject it.',
          output: z.object({
            decision: z.enum(['approve', 'reject']),
            comments: z.string().optional(),
          }),
        }),
      },
    }),

    // Step 5: Route on decision.
    branch({
      id: 'decision-gate',
      on: (ctx) => {
        const gate = ctx.steps['auto-approve-gate'] as
          | { decision: string; wasAuto?: boolean }
          | { decision: string; comments?: string }
        return gate.decision === 'approve' ? 'approve' : 'reject'
      },
      cases: {
        approve: code({
          id: 'on-approve',
          run: (ctx) => {
            const { amount } = ctx.input as ApprovalInput
            return { outcome: 'approved', finalAmount: amount }
          },
        }),
        reject: code({
          id: 'on-reject',
          run: () => ({ outcome: 'rejected', finalAmount: 0 }),
        }),
      },
    }),
  ],

  finalize: (ctx) => {
    const validation = ctx.steps.validate as { valid: boolean; reason: string }
    if (!validation.valid) {
      return {
        status: 'invalid' as const,
        reviewerComments: validation.reason,
        finalAmount: 0,
        autoApproved: false,
      }
    }

    const decisionGate = ctx.steps['decision-gate'] as { outcome: string; finalAmount: number }
    const autoApproveGate = ctx.steps['auto-approve-gate'] as
      | { decision: string; wasAuto?: boolean; comments?: string }
      | undefined

    const wasAuto = (autoApproveGate as { wasAuto?: boolean } | undefined)?.wasAuto ?? false
    // `comments` is optional on the wait() output schema, so a human reviewer
    // may legitimately submit none. Distinguish the three sources explicitly
    // rather than emitting an empty string that looks like a vetted answer.
    const comments =
      (autoApproveGate as { comments?: string } | undefined)?.comments ??
      (wasAuto ? 'Auto-approved (below threshold)' : 'No reviewer comments provided')

    return {
      status: decisionGate.outcome === 'approved' ? ('approved' as const) : ('rejected' as const),
      reviewerComments: comments,
      finalAmount: decisionGate.finalAmount,
      autoApproved: wasAuto,
    }
  },
})
