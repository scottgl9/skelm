# approval-workflow

Human-in-the-loop expense approval using `wait()` and `branch()`.

Demonstrates: `wait()`, `branch()`, auto-approve fast path, gateway resume via HTTP.

## What it does

1. **Validate** — rejects immediately if the amount or category is missing.
2. **Auto-approve** — expenses under $100 skip human review entirely.
3. **Human review** (`wait`) — for larger amounts, the run pauses until a manager resumes it with `{ decision: "approve" | "reject", comments?: string }`.
4. **Branch on decision** — routes to an approve or reject outcome.

## Auto-approve path (no gateway needed)

```bash
skelm run approval-workflow.pipeline.mts \
  --input '{"employeeName":"Bob","amount":45,"category":"Meals","description":"Team lunch"}'
# → { "status": "approved", "autoApproved": true, "finalAmount": 45 }
```

## Human review path (requires gateway)

```bash
# 1. Start the gateway
skelm gateway start

# 2. Start the run asynchronously — copy the runId from the response
curl -s http://127.0.0.1:14738/pipelines/approval-workflow.pipeline.mts/start \
  -H 'Content-Type: application/json' \
  -d '{"input":{"employeeName":"Alice","amount":350,"category":"Travel","description":"Flight to customer site"}}' | jq .

# 3. Resume with a decision (replace <runId>)
curl -s http://127.0.0.1:14738/runs/<runId>/resume \
  -H 'Content-Type: application/json' \
  -d '{"output":{"decision":"approve","comments":"Pre-approved by budget policy"}}'

# 4. Check the final result
curl -s http://127.0.0.1:14738/runs/<runId>/events | jq .
```

## Adapting for production

- Replace the `code` steps with real Slack messages, email notifications, or a custom approval UI.
- The `wait()` output schema validates the resume payload — extend it with `approver`, `timestamp`, etc.
- Set `timeoutMs` on the `wait()` step to auto-reject stale requests.
