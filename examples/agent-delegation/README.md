# agent-delegation

Multi-agent orchestration: a **router** agent delegates research questions to a
**research-specialist** agent via the built-in `delegate` tool.

```
router (agent)
  └─ delegate("research-specialist", { question })  ──▶  research-specialist (agent)
                                                              └─ answers, returns output
  ◀─ { status: "completed", output } ──────────────────────────┘
```

## Run it

Point the backend at any OpenAI-compatible chat endpoint:

```sh
SKELM_AGENT_URL=http://localhost:8000/v1 SKELM_AGENT_MODEL=qwen36 \
  skelm run router.workflow.mts --input '{"message":"What is a quine in programming?"}'
```

The router calls `delegate` with `agentId: "research-specialist"`, the specialist
runs as a child, and the router reports its answer back.

## What to notice

- **`delegation` is default-deny.** The router declares `delegation: ['research-specialist']`
  in `router.workflow.mts`. Remove that line and the `delegate` call is refused —
  the model gets a permission-denied tool result and can't reach the specialist.
- **The child is bounded by the parent.** The specialist's effective permissions
  are intersected with the router's. A delegated agent can never do more than the
  agent that delegated to it. See [docs/concepts/delegation.md](../../docs/concepts/delegation.md).
- **Targets are pipeline ids.** `research-specialist` is just another workflow in
  this directory — a one-agent pipeline acting as a named specialist.
