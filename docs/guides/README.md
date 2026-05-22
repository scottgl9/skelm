# Guides

Task-oriented how-to documents. Each guide assumes you have read the [Concepts](../concepts/) section.

## Authoring

- [Writing a Backend](./writing-a-backend.md) — implement `SkelmBackend` to power `llm()` and `agent()` steps with a private model or custom runtime.
- [Writing a Plugin](./writing-a-plugin.md) — package providers, backends, hooks, secret drivers, or skill packs as a regular npm dependency.
- [Testing Workflows](./testing-workflows.md) — exercise pipelines without standing up a gateway, mocking the network, or hitting a real LLM.

## Operating the gateway

- [Gateway](./gateway.md) — the long-running process: lifecycle, registries, HTTP/SSE, supervision.
- [Triggers](./triggers.md) — fire workflows from schedules, webhooks, queues, and external sources.
- [ACP Sessions](./acp-sessions.md) — resident ACP agents and durable conversation state.
- [MCP Serve](./mcp-serve.md) — expose local skelm pipelines as MCP tools over stdio for MCP-compatible clients.
- [MCP Servers](./mcp-servers.md) — declare and supervise MCP servers as registry citizens.

## Security and compliance

- [Permissions and Approvals](./approvals.md) — pause runs for human approval on risky actions.
- [Secrets](./secrets.md) — gateway-owned `SecretResolver`: pipelines reference names, not values.
- [Audit](./audit.md) — the hash-chained append-only log and how to consume it.
- [Production Hardening](./production-hardening.md) — checklist for going from `pnpm dev` to a deployed gateway.

Project validation notes live in the [self-test plan](../skelm-self-test-plan.md).

For the underlying primitives, see [Reference](../reference/).
