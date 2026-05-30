# Recipe — HTTP-triggered enrichment

A workflow called from existing infrastructure (queue worker, GitHub webhook, internal HTTP service) that enriches a payload with deterministic computation plus an LLM classification, then posts the result to Slack.

This recipe is the simplest production-shaped pattern: one HTTP entry point, predictable latency, no scheduler / state / workspace needed. If your team already has a queue worker, a Kafka consumer, or a webhook receiver and you want to add LLM-flavored work to it, start here.

This recipe exercises:

- Sync HTTP invocation (`POST /pipelines/:id/run`)
- Idempotency-Key header
- A pure deterministic-then-LLM workflow with no agent loop
- Structured output via Zod schema
- Bearer auth on a non-loopback gateway

## Project layout

```
http-enrichment/
├── skelm.config.ts
├── workflows/
│   └── enrich-and-post.workflow.mts
├── secrets/
└── package.json
```

No `agents/` directory — agent definitions are not needed for an LLM-only flow.

## `skelm.config.ts`

```ts
import { defineConfig } from 'skelm'

export default defineConfig({
  backends: {
    default: 'openai',
    openai: {
      // Hosted OpenAI by default. Point baseUrl at any OpenAI-compatible URL
      // (vLLM, llama.cpp, sglang, ollama with /v1, etc.) to use a local model.
      apiKey: { secret: 'OPENAI_API_KEY' },
      model:  'gpt-4o-mini',
    },
  },
  defaults: {
    permissions: {
      networkEgress: 'deny',
      allowedExecutables: [],
      allowedTools: [],
      allowedSkills: [],
      allowedMcpServers: [],
      fsRead: [],
      fsWrite: [],
    },
  },
  server: {
    port: 14738,
    host: '0.0.0.0',                // exposed; bearer auth required
    auth: { mode: 'bearer' },        // SKELM_TOKEN env
    maxConcurrentRuns: 50,
  },
  secrets: { driver: 'env' },
})
```

## `workflows/enrich-and-post.workflow.mts`

```ts
import { pipeline, code, infer } from 'skelm'
import { z } from 'zod'

const inboundEvent = z.object({
  type: z.enum(['issue.opened', 'pr.opened', 'comment.added']),
  repo: z.string(),
  payload: z.record(z.unknown()),
})

export default pipeline({
  id: 'enrich-and-post',
  description: 'Classify an inbound event and post to Slack if it matters.',
  input:  inboundEvent,
  output: z.object({
    classification: z.enum(['notable', 'routine', 'noise']),
    posted: z.boolean(),
    slackTs: z.string().optional(),
  }),
  steps: [
    code({
      id: 'normalize',
      run: (ctx) => {
        // Deterministic: derive a canonical summary string from the payload shape.
        const p = ctx.input.payload as Record<string, any>
        const summary = ctx.input.type === 'issue.opened'
          ? `Issue: ${p.title}`
          : ctx.input.type === 'pr.opened'
          ? `PR: ${p.title}`
          : `Comment: ${p.body?.slice(0, 200)}`
        return { summary, repo: ctx.input.repo, eventType: ctx.input.type }
      },
    }),
    infer({
      id: 'classify',
      backend: 'openai',
      prompt: (ctx) => `
        Classify the following repository event as notable, routine, or noise.
        notable = ops/security/release relevance; team should see it.
        routine = normal day-to-day activity.
        noise = automated, low-signal, dependabot-style.

        Repository: ${ctx.steps.normalize.repo}
        Type: ${ctx.steps.normalize.eventType}
        Summary: ${ctx.steps.normalize.summary}
      `,
      output: z.object({
        classification: z.enum(['notable', 'routine', 'noise']),
        reasoning: z.string(),
      }),
    }),
    code({
      id: 'post',
      run: async (ctx) => {
        if (ctx.steps.classify.classification !== 'notable') {
          return { posted: false }
        }
        const slackTs = await postToSlack({
          channel: '#ops',
          text: `${ctx.steps.normalize.summary}\n_${ctx.steps.classify.reasoning}_`,
        })
        return { posted: true, slackTs }
      },
    }),
  ],
  finalize: (ctx) => ({
    classification: ctx.steps.classify.classification,
    posted: ctx.steps.post.posted,
    slackTs: ctx.steps.post.slackTs,
  }),
})
```

## Run the gateway

```sh
SKELM_TOKEN=$(openssl rand -hex 32) skelm gateway start
echo $SKELM_TOKEN > ~/.skelm/token
chmod 600 ~/.skelm/token
```

For a persistent deployment, install it as a systemd user service instead:

```sh
# Generate token and save it
export SKELM_TOKEN=$(openssl rand -hex 32)
echo $SKELM_TOKEN > ~/.skelm/token && chmod 600 ~/.skelm/token

# Make the token available to the systemd service
systemctl --user set-environment SKELM_TOKEN=$SKELM_TOKEN

# Install and start the service
skelm gateway install
```

> **Note:** `systemctl --user set-environment` sets the variable for the current user manager session. To make it persistent across reboots, add `Environment=SKELM_TOKEN=<token>` to a systemd drop-in (e.g. `~/.config/systemd/user/skelm-gateway.service.d/token.env`):
>
> ```sh
> mkdir -p ~/.config/systemd/user/skelm-gateway.service.d
> echo -e '[Service]\nEnvironment=SKELM_TOKEN='$SKELM_TOKEN \
>   > ~/.config/systemd/user/skelm-gateway.service.d/token.env
> chmod 600 ~/.config/systemd/user/skelm-gateway.service.d/token.env
> systemctl --user daemon-reload
> ```

## Call it from your existing infrastructure

```sh
TOKEN=$(cat ~/.skelm/token)
curl -X POST http://gateway-host:14738/pipelines/enrich-and-post/run \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: gh-event-$(date +%s)-$$" \
  -d '{
    "input": {
      "type": "pr.opened",
      "repo": "acme/api",
      "payload": { "title": "Bump dependencies for security advisory CVE-2024-XXXX", "number": 4242 }
    }
  }'
```

Response:

```json
{
  "runId": "...",
  "status": "completed",
  "output": {
    "classification": "notable",
    "posted": true,
    "slackTs": "1730000000.000200"
  }
}
```

## Async flavor

For long-running enrichments where you do not want to hold the HTTP connection:

```sh
curl -X POST http://gateway-host:14738/pipelines/enrich-and-post/start \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{ "input": { ... } }'
# → 202 { "runId": "abc", "status": "running" }

# Poll for completion
curl -H "Authorization: Bearer $TOKEN" http://gateway-host:14738/runs/abc

# Or fetch the persisted event log (use ?since=<index> to tail)
curl -H "Authorization: Bearer $TOKEN" http://gateway-host:14738/runs/abc/events
```

## Why each piece is here

- **No agent step.** Classification is a single LLM call. Latency is one round-trip plus a small fixed overhead.
- **Deterministic normalization first.** The `code()` step gives the LLM a consistent shape regardless of how the upstream payload varies. Easier to evaluate accuracy.
- **Structured output schema on `infer()`.** The runtime forces the LLM to return JSON matching the schema; the `code()` step that consumes it does not have to guess at parsing.
- **`Idempotency-Key`.** Retries from the upstream caller (network blip, queue redelivery) are safe. The same key returns the same `runId`.
- **`bearer` auth.** The gateway is exposed on `0.0.0.0`; auth is enforced. Skelm refuses `--host 0.0.0.0` with `auth.mode: none` at startup.

## What this recipe deliberately does not do

- No persistent state. Each call is independent. If you need cross-call dedupe (e.g., suppress duplicate Slack posts), the upstream caller passes a stable `Idempotency-Key` — that is the right layer for it.
- No workspace. There are no files involved.
- No scheduler config. The upstream system is the trigger.

## Observability

```sh
curl -H "Authorization: Bearer $TOKEN" http://gateway-host:14738/runs?workflowId=enrich-and-post&limit=20
```

For Prometheus:

```
skelm_runs_total{workflow="enrich-and-post",status="completed"}
skelm_run_duration_seconds{workflow="enrich-and-post"}
skelm_tokens_total{workflow="enrich-and-post",direction="output"}
```

## Production checklist

1. `SKELM_TOKEN` is set, length ≥ 32 chars, not committed.
2. The gateway is behind a reverse proxy with TLS — terminate TLS in your fronting proxy (nginx, caddy, traefik, ALB).
3. `OPENAI_API_KEY` is in the secrets driver, not a config file.
4. `defaults.permissions` is verified default-deny.
5. A Prometheus scrape is configured against `/metrics` (gated by auth).
6. Audit retention policy is set (default forever; M3+).
7. Backups of `runs.db` and `audit.db` are scheduled (filesystem-level).
