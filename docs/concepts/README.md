# Concepts

Foundational ideas to keep in mind when reading the rest of the docs.

- [Permissions](./permissions.md) — the gateway is the trust boundary; every privileged action flows through it under default-deny rules.
- [Coding Agents](./coding-agents.md) — how skelm models opencode, ACP runtimes, and other agents as registry entries with explicit lifecycles.
- [System Prompt](./system-prompt.md) — how `buildSystemPrompt` composes the prompt sent to agent backends, and the three knobs for customizing it.
- [Registries](./registries.md) — the four gateway registries (agents, backends, MCP servers, secrets) and how `skelm.config.ts` populates them.

If you are new to skelm, start with [Permissions](./permissions.md) — every other concept assumes you understand default-deny.
