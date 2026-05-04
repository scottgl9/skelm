# matrix-coding-agent

A single-agent workflow triggered by a Matrix message. The "openclaw-style" use case: a coding agent listens in a Matrix room, picks up a message, and runs a one-shot task against it.

The pipeline itself is a single `agent()` step. The agent is registered with the gateway as `lifecycle: 'ephemeral'` — the gateway spawns it for the message, the agent does the task, and the process exits. No resident `serve` process needed for this shape.

## Files

- `matrix-coding-agent.workflow.ts` — the workflow.
- `skelm.config.ts` — registers a fake `claude-code` ephemeral agent and a Matrix MCP server (mocked).

## Run

```bash
# Start the gateway (it loads skelm.config.ts in this directory).
SKELM_CONFIG=./examples/matrix-coding-agent/skelm.config.ts \
  skelm gateway start --foreground
```

Then in another shell, fire the trigger manually (the Matrix transport plugin would call this on every incoming message):

```bash
skelm run examples/matrix-coding-agent/matrix-coding-agent.workflow.ts \
  --input '{"message":"add a regression test for the login bug","room":"#dev"}'
```

The gateway spawns the agent, runs the task, and writes the result to stdout. Audit chain captures the spawn, exit, and any permission decisions.
