# incident-response

Automated incident triage pipeline triggered by a webhook.

Demonstrates: `parallel()`, `branch()`, `agent()`, webhook trigger, Zod output schema.

## What it does

1. **Severity gate** (`branch`) — critical/high incidents escalate; medium/low get a lightweight acknowledgement and stop.
2. **Parallel triage** (`parallel`) — simultaneously searches for related GitHub issues and creates a Slack incident channel.
3. **Root-cause analysis** (`agent`) — an LLM analyses the service context and related issues to identify the root cause and suggest immediate actions.
4. **Ticket + notify** (`code`) — simulates Jira ticket creation and a Slack summary post.

The `code` steps use simulated data. Swap them for real SDK calls (`@slack/web-api`, `@octokit/rest`, `jira.js`) in production.

## Run

```bash
OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_API_KEY=unused OPENAI_MODEL=qwen35 \
  skelm run incident-response.pipeline.mts \
  --input '{"incidentId":"INC-001","severity":"critical","service":"auth-service","description":"Users unable to login — 503 errors on /api/auth endpoint"}'
```

Low-severity example (skips the agent step):

```bash
OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_API_KEY=unused OPENAI_MODEL=qwen35 \
  skelm run incident-response.pipeline.mts \
  --input '{"incidentId":"INC-002","severity":"low","service":"reporting","description":"Slow dashboard loads"}'
```

## Webhook trigger

When the gateway is running, POST to `/webhooks/incident` to fire the pipeline:

```bash
skelm gateway start --foreground
curl -X POST http://127.0.0.1:14738/webhooks/incident \
  -H 'Content-Type: application/json' \
  -d '{"incidentId":"INC-003","severity":"high","service":"payments","description":"Checkout failures spiking"}'
```
