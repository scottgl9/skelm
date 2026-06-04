# skelm examples

Runnable workflow examples. Each subdirectory is a self-contained workflow you can run with `skelm`.

| Example                  | What it shows                                                              |
| ------------------------ | -------------------------------------------------------------------------- |
| `hello/`                 | One-step greeting with a Zod input schema.                                 |
| `sum/`                   | Multi-step: typed `ctx.steps[id]` flowing through three code steps.        |
| `permissions-demo/`      | `TrustEnforcer` usage in a `code()` step against a deny-all policy.        |
| `multi-step-pipeline/`   | Sequential composition with branching/control flow.                        |
| `vercel-ai-bot/`         | Minimal Vercel AI backend greeting pipeline.                               |
| `telegram-bot/`          | Long-poll Telegram bot driving an `agent()` step on the pi backend.        |
| `incident-response/`     | Webhook-triggered triage: `parallel()` + `branch()` + `agent()` root-cause.|
| `approval-workflow/`     | Human-in-the-loop expense approval via `wait()`; auto-approves under $100. |
| `sprint-planning/`       | Cron-triggered LLM story selection feeding from `code()` capacity calc.    |
| `agentmemory/`           | Cross-session recall via the agentmemory integration (two-run pattern).    |
| `agentmemory-smoke/`     | Minimal agentmemory smoke workflow for local integration checks.           |
| `telegram-assistant/`    | Persistent agent over Telegram: durable per-chat conversation + agentmemory.|
| `matrix-assistant/`      | Persistent agent over Matrix with durable per-room conversation.            |
| `chatui-assistant/`      | Persistent agent over a local chat UI — terminal **or** browser — from one integration: durable session + agentmemory. |
| `agent-delegation/`      | Multi-agent: a router `agent()` delegates to a specialist via the `delegate` tool. |
| `pi-sdk-smoke/`          | Minimal pi SDK backend smoke pipeline with tool execution.                 |
| `dashboard-demo/`        | Static dashboard page for gateway dashboard endpoints.                     |

## Run

From the repo root:

```sh
pnpm build
node packages/skelm/dist/bin.js run examples/hello/hello.workflow.mts --input '{"name":"world"}'
node packages/skelm/dist/bin.js run examples/sum/sum.workflow.mts --input '{"a":2,"b":3}'
node packages/skelm/dist/bin.js run examples/permissions-demo/demo.workflow.mts --input '{}'
node packages/skelm/dist/bin.js run examples/multi-step-pipeline/multi-step.workflow.mts --input '{"task":"investigate the login bug"}'
```

Once `skelm` is installed globally (`npm i -g skelm`), the same commands shorten to `skelm run examples/...`.

`telegram-bot/` is a gateway-hosted long-poll Telegram Bot API example — see [`telegram-bot/README.md`](./telegram-bot/README.md) for the bot token + pi setup.

Trigger-driven examples (`telegram-bot/`, `telegram-assistant/`, `matrix-assistant/`, `chatui-assistant/`) run under the gateway: `skelm gateway start` from the example directory, or `skelm run examples/<dir>/` for project activation where the README says to activate. `chatui-assistant/` serves both a terminal frontend (`skelm run examples/chatui-assistant/`) and a static web page (`web-chat.html`, gateway started with `SKELM_DEV_CORS=1`); you can also exercise the terminal UI alone with `node examples/chatui-assistant/drive.mts` (no gateway, no model). See each example's README.
