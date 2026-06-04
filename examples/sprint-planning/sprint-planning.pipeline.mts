import { agent, code, pipeline } from '@skelm/core'
import { z } from 'zod'

/**
 * Sprint planning pipeline — cron-triggered, LLM-assisted story selection.
 *
 * Demonstrates: cron trigger, agent() with structured output schema,
 * data flowing from code() into an agent() prompt.
 *
 * Every Friday at 2 PM the gateway fires this pipeline. It:
 *   1. Fetches the team's backlog (simulated — replace with Jira SDK).
 *   2. Calculates team capacity for the sprint.
 *   3. Uses an LLM to select the optimal set of stories given capacity
 *      and priority (the killer feature vs. plain n8n/cron scripts).
 *   4. Simulates sprint creation in Jira and team notification in Slack.
 *
 * Run manually:
 *   OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_API_KEY=unused OPENAI_MODEL=qwen35 \
 *     skelm run sprint-planning.pipeline.mts \
 *     --input '{"projectKey":"ENG","teamSize":5,"sprintDuration":14}'
 */

export const SprintInputSchema = z.object({
  projectKey: z.string().min(1),
  teamSize: z.number().int().positive(),
  sprintDuration: z.number().int().positive().default(14),
  targetPoints: z.number().optional(),
})

export const SprintOutputSchema = z.object({
  sprintName: z.string(),
  selectedStories: z.array(z.string()),
  totalPoints: z.number(),
  capacityPoints: z.number(),
  rationale: z.string(),
})

export type SprintInput = z.infer<typeof SprintInputSchema>

/** Sample backlog — replace with a real Jira API call in production. */
const SAMPLE_BACKLOG = [
  { id: 'ENG-101', title: 'Migrate auth service to OAuth 2.0', points: 13, priority: 'critical' },
  { id: 'ENG-102', title: 'Fix connection pool leak in payments', points: 8, priority: 'high' },
  { id: 'ENG-103', title: 'Add rate limiting to public API', points: 5, priority: 'high' },
  { id: 'ENG-104', title: 'Dashboard slow-load performance fix', points: 8, priority: 'medium' },
  { id: 'ENG-105', title: 'Upgrade Node.js to v22 LTS', points: 3, priority: 'medium' },
  { id: 'ENG-106', title: 'Add OpenTelemetry traces to checkout', points: 5, priority: 'medium' },
  { id: 'ENG-107', title: 'Write integration tests for billing', points: 8, priority: 'medium' },
  { id: 'ENG-108', title: 'Refactor legacy report generator', points: 13, priority: 'low' },
  { id: 'ENG-109', title: 'Update third-party dependency audit', points: 2, priority: 'low' },
  { id: 'ENG-110', title: 'Document new webhook events', points: 3, priority: 'low' },
]

export default pipeline({
  id: 'sprint-planning',
  description: 'LLM-assisted sprint planning: fetch backlog → calculate capacity → select stories.',
  input: SprintInputSchema,
  output: SprintOutputSchema,
  triggers: [{ kind: 'cron', cron: '0 14 * * 5' }], // 2 PM every Friday
  steps: [
    // Step 1: Fetch backlog (simulated).
    code({
      id: 'fetch-backlog',
      run: (ctx) => {
        const { projectKey } = ctx.input as SprintInput
        // Production: replace with Jira SDK call — jira.issueSearch({ jql: `project=${projectKey} AND status=Backlog ORDER BY priority` })
        return { backlog: SAMPLE_BACKLOG, projectKey }
      },
    }),

    // Step 2: Calculate team capacity.
    code({
      id: 'calculate-capacity',
      run: (ctx) => {
        const { teamSize, sprintDuration, projectKey } = ctx.input as SprintInput
        // Assume ~1 point per engineer-day at 70% efficiency.
        const capacityPoints = Math.floor(teamSize * sprintDuration * 0.7)
        const sprintNumber = Math.ceil(Date.now() / (1000 * 60 * 60 * 24 * 14)) // rough sprint counter
        const sprintName = `${projectKey} Sprint ${sprintNumber}`
        return { capacityPoints, sprintName }
      },
    }),

    // Step 3: LLM selects the optimal story set.
    agent({
      id: 'select-stories',
      backend: 'vercel-ai',
      prompt: (ctx) => {
        const { backlog } = ctx.steps['fetch-backlog'] as { backlog: typeof SAMPLE_BACKLOG }
        const { capacityPoints, sprintName } = ctx.steps['calculate-capacity'] as {
          capacityPoints: number
          sprintName: string
        }
        const { targetPoints } = ctx.input as SprintInput
        // Clamp the target to capacity: callers can request a *lower* load than
        // capacity for de-risked sprints, but the prompt should never tell the
        // LLM to plan beyond what the team can deliver.
        const target = Math.min(targetPoints ?? capacityPoints, capacityPoints)

        const backlogText = backlog
          .map((s) => `  ${s.id} [${s.priority}] ${s.title} — ${s.points}pts`)
          .join('\n')

        return `You are an engineering manager planning ${sprintName}.

Team capacity: ${capacityPoints} story points.
Target load: ${target} points (stay within capacity).

Backlog (in rough priority order):
${backlogText}

Select the optimal set of stories for this sprint. Prioritise critical and high items first,
then fill remaining capacity with medium items. Do not exceed the target points.

Reply ONLY with JSON matching this schema exactly:
{"selectedIds":["ENG-XXX"],"totalPoints":0,"rationale":"<one paragraph explaining your selection>"}`
      },
      output: z.object({
        selectedIds: z.array(z.string()),
        totalPoints: z.number(),
        rationale: z.string(),
      }),
      permissions: {
        allowedTools: [],
        allowedExecutables: [],
        allowedMcpServers: [],
        allowedSkills: [],
        fsRead: [],
        fsWrite: [],
        // vercel-ai runs in-process; the gateway egress proxy can't intercept
        // it. The local OpenAI-compatible endpoint reaches itself directly.
        networkEgress: 'allow',
      },
      maxTurns: 1,
      timeoutMs: 60_000,
    }),

    // Step 4: Simulate sprint creation in Jira.
    code({
      id: 'create-sprint',
      run: (ctx) => {
        const { sprintName } = ctx.steps['calculate-capacity'] as { sprintName: string }
        // Agent output with a schema is on ctx.steps[id] directly.
        const selection = ctx.steps['select-stories'] as
          | { selectedIds: string[]; totalPoints: number; rationale: string }
          | undefined
        const ids = selection?.selectedIds ?? []
        // Production: replace with Jira SDK sprint creation.
        console.log(
          `[create-sprint] Would create sprint "${sprintName}" with stories: ${ids.join(', ')}`,
        )
        return { sprintId: `SPRINT-${Date.now()}`, sprintName, created: true }
      },
    }),

    // Step 5: Simulate Slack notification.
    code({
      id: 'notify-team',
      run: (ctx) => {
        const sprint = ctx.steps['create-sprint'] as { sprintName: string; sprintId: string }
        const selection = ctx.steps['select-stories'] as
          | { selectedIds: string[]; totalPoints: number }
          | undefined
        // Production: replace with Slack SDK message.
        console.log(
          `[notify-team] Sprint "${sprint.sprintName}" planned: ` +
            `${selection?.selectedIds.length ?? 0} stories, ${selection?.totalPoints ?? 0}pts`,
        )
        return { notified: true }
      },
    }),
  ],

  finalize: (ctx) => {
    const capacity = ctx.steps['calculate-capacity'] as {
      capacityPoints: number
      sprintName: string
    }
    const selection = ctx.steps['select-stories'] as
      | { selectedIds: string[]; totalPoints: number; rationale: string }
      | undefined

    return {
      sprintName: capacity.sprintName,
      selectedStories: selection?.selectedIds ?? [],
      totalPoints: selection?.totalPoints ?? 0,
      capacityPoints: capacity.capacityPoints,
      rationale: selection?.rationale ?? '',
    }
  },
})
