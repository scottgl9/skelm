# skelm examples

Runnable workflow examples. Each subdirectory is a self-contained workflow you can run with `skelm`.

| Example                  | What it shows                                                              |
| ------------------------ | -------------------------------------------------------------------------- |
| `hello/`                 | One-step greeting with a Zod input schema.                                 |
| `sum/`                   | Multi-step: typed `ctx.steps[id]` flowing through three code steps.        |
| `permissions-demo/`      | `TrustEnforcer` usage in a `code()` step against a deny-all policy.        |
| `multi-step-pipeline/`   | Sequential composition with branching/control flow.                        |
| `telegram-bot/`          | Long-poll Telegram bot driving an `agent()` step on the pi backend.        |
| `incident-response/`     | Webhook-triggered triage: `parallel()` + `branch()` + `agent()` root-cause.|
| `approval-workflow/`     | Human-in-the-loop expense approval via `wait()`; auto-approves under $100. |
| `sprint-planning/`       | Cron-triggered LLM story selection feeding from `code()` capacity calc.    |
| `agentmemory/`           | Cross-session recall via the agentmemory integration (two-run pattern).    |
| `telegram-assistant/`    | Persistent agent over Telegram: durable per-chat conversation + agentmemory.|
| `tui-assistant/`         | Persistent agent over a local terminal UI: durable session + agentmemory.  |

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

`telegram-bot/` is a standalone runner that long-polls the Telegram Bot API and drives the pipeline directly — see [`telegram-bot/README.md`](./telegram-bot/README.md) for the bot token + pi setup.

Trigger-driven examples (`telegram-assistant/`, `tui-assistant/`) run under the gateway: `skelm gateway start` from the example directory. `tui-assistant/` binds to your terminal, so run the gateway in the foreground; you can also exercise its UI alone with `node examples/tui-assistant/drive.mts` (no gateway, no model). See each example's README.
