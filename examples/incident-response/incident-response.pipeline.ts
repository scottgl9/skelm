import { agent, branch, code, parallel, pipeline } from '@skelm/core'
import { z } from 'zod'

/**
 * Incident response pipeline.
 *
 * Triggered by a webhook (e.g. PagerDuty, Alertmanager). For critical/high
 * severity incidents it:
 *   1. Gates on severity — low/medium get a lightweight acknowledgement only.
 *   2. Runs triage in parallel: simulated GitHub issue search + Slack channel
 *      creation (swap `code` for real SDK calls in production).
 *   3. Uses an LLM agent to analyse the root cause given the service context
 *      and any related issues found.
 *   4. Simulates Jira ticket creation and a Slack summary post.
 *
 * Demonstrates: parallel(), branch(), agent(), webhook trigger, output schema.
 *
 * Run locally:
 *   OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_API_KEY=unused OPENAI_MODEL=qwen35 \
 *     skelm run incident-response.pipeline.ts \
 *     --input '{"incidentId":"INC-001","severity":"critical","service":"auth-service","description":"Users unable to login — 503 errors on /api/auth"}'
 */

export const IncidentInputSchema = z.object({
  incidentId: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  service: z.string(),
  description: z.string(),
})

export const IncidentOutputSchema = z.object({
  channel: z.string(),
  ticketId: z.string(),
  rootCause: z.string(),
  immediateActions: z.array(z.string()),
  acknowledged: z.boolean(),
})

export type IncidentInput = z.infer<typeof IncidentInputSchema>

export default pipeline({
  id: 'incident-response',
  description: 'Automated incident triage: parallel investigation → LLM root-cause → Jira + Slack.',
  input: IncidentInputSchema,
  output: IncidentOutputSchema,
  triggers: [{ kind: 'webhook', path: '/webhooks/incident' }],
  steps: [
    // Gate: low/medium severity → lightweight acknowledgement only.
    branch({
      id: 'severity-gate',
      on: (ctx) => {
        const sev = (ctx.input as IncidentInput).severity
        return sev === 'critical' || sev === 'high' ? 'escalate' : 'acknowledge'
      },
      cases: {
        escalate: code({ id: 'escalate', run: () => ({ escalated: true }) }),
        acknowledge: code({ id: 'acknowledge', run: () => ({ escalated: false }) }),
      },
    }),

    // Parallel triage: GitHub issue search + Slack channel creation.
    parallel({
      id: 'triage',
      steps: [
        code({
          id: 'search-issues',
          run: (ctx) => {
            const { service } = ctx.input as IncidentInput
            // Production: replace with real GitHub API call.
            return {
              issues: [
                {
                  title: `[${service}] High latency observed`,
                  url: 'https://github.com/example/repo/issues/42',
                },
                {
                  title: `[${service}] Connection pool exhaustion`,
                  url: 'https://github.com/example/repo/issues/38',
                },
              ],
            }
          },
        }),
        code({
          id: 'create-channel',
          run: (ctx) => {
            const { incidentId, service } = ctx.input as IncidentInput
            // Production: replace with Slack API call.
            const channelName = `inc-${incidentId.toLowerCase()}-${service}`
            return { channelId: 'C0INCIDENT01', channelName }
          },
        }),
      ],
    }),

    // Agent: root-cause analysis given context + found issues.
    agent({
      id: 'root-cause',
      backend: 'vercel-ai',
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
      prompt: (ctx) => {
        const { service, description, severity } = ctx.input as IncidentInput
        const triage = ctx.steps.triage as {
          'search-issues': { issues: Array<{ title: string; url: string }> }
        }
        const issueList = triage['search-issues'].issues
          .map((i) => `- ${i.title} (${i.url})`)
          .join('\n')
        return `You are an on-call SRE analyzing a ${severity} incident.

Service: ${service}
Description: ${description}

Related open issues:
${issueList}

Analyze the likely root cause and provide 2-3 immediate actions the team should take right now.
Reply ONLY with JSON matching this schema exactly:
{"rootCause":"<one sentence>","immediateActions":["<action 1>","<action 2>"],"severity":"${severity}"}`
      },
      output: z.object({
        rootCause: z.string(),
        immediateActions: z.array(z.string()),
        severity: z.string(),
      }),
      // No permissions declared — vercel-ai runs in-process against a local
      // endpoint, so the egress proxy is not needed. For production use with
      // real external APIs, consider a subprocess backend (pi, opencode).
      maxTurns: 1,
      timeoutMs: 60_000,
    }),

    // Simulate Jira ticket creation.
    code({
      id: 'create-ticket',
      run: (ctx) => {
        const { incidentId } = ctx.input as IncidentInput
        // Production: replace with Jira SDK call.
        const num = incidentId.replace(/\D/g, '') || '001'
        return {
          ticketId: `INC-${num}`,
          ticketUrl: `https://jira.example.com/browse/INC-${num}`,
        }
      },
    }),

    // Simulate Slack summary post.
    code({
      id: 'notify',
      run: (ctx) => {
        const triage = ctx.steps.triage as { 'create-channel': { channelName: string } }
        const ticket = ctx.steps['create-ticket'] as { ticketId: string }
        // Production: replace with Slack SDK call.
        console.log(
          `[notify] Posted summary to #${triage['create-channel'].channelName}: ticket=${ticket.ticketId}`,
        )
        return { posted: true }
      },
    }),
  ],

  finalize: (ctx) => {
    const gate = ctx.steps['severity-gate'] as { escalated: boolean }

    // Low/medium severity short-circuits the escalation work — triage, the
    // root-cause agent, and the Jira ticket creation may never have run, so
    // their step outputs can be undefined. Return the acknowledgement shape
    // directly instead of attempting to dereference them.
    if (!gate.escalated) {
      return {
        channel: '',
        ticketId: '',
        rootCause: 'Acknowledged only — low/medium severity did not escalate',
        immediateActions: [],
        acknowledged: true,
      }
    }

    const triage = ctx.steps.triage as {
      'create-channel': { channelId: string; channelName: string }
    }
    const ticket = ctx.steps['create-ticket'] as { ticketId: string }
    // Agent steps with an output schema produce the validated object directly
    // on ctx.steps[id]; there is no `.structured` wrapper.
    const rca = ctx.steps['root-cause'] as
      | { rootCause: string; immediateActions: string[] }
      | undefined

    return {
      channel: triage['create-channel'].channelName,
      ticketId: ticket.ticketId,
      rootCause: rca?.rootCause ?? 'Analysis unavailable',
      immediateActions: rca?.immediateActions ?? [],
      acknowledged: false,
    }
  },
})
