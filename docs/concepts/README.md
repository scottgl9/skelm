# Concepts

Foundational ideas to keep in mind when reading the rest of the docs.

- [Permissions](./permissions.md) — the gateway is the trust boundary; every privileged action flows through it under default-deny rules.
- [Human-in-the-loop](./human-in-the-loop.md) — durable pause points that suspend a run awaiting a typed human decision.
- [Guardrails & Oversight](./guardrails.md) — run-level pre/in/post-run validators, budgets, watchdog, and supervisor-driven pause/escalate/terminate interventions.
- [Delegation](./delegation.md) — agent-to-agent hand-off via the `delegate` tool; how a delegated child is bounded to a subset of its parent's permissions.
- [Persistent Workflows](./persistent-workflows.md) — durable, session-keyed conversations driven by chat, queue, cron, or webhook triggers.
- [Coding Agents](./coding-agents.md) — how skelm models opencode, ACP runtimes, and other agents as registry entries with explicit lifecycles.
- [System Prompt](./system-prompt.md) — how `buildSystemPrompt` composes the prompt sent to agent backends, and the three knobs for customizing it.
- [Registries](./registries.md) — the four gateway registries (agents, backends, MCP servers, secrets) and how `skelm.config.ts` populates them.

If you are new to skelm, start with [Permissions](./permissions.md) — every other concept assumes you understand default-deny.
