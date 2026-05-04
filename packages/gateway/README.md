# @skelm/gateway

The long-running orchestrator at the heart of skelm.

The gateway is the canonical trust boundary and the home of every persistent concern:

- **Config** — loads `skelm.config.ts`, watches for changes, hot-reloads on edit or `SIGHUP`.
- **Registries** — workflows, skills, MCP servers, agents (ACP + coding agents), triggers.
- **Enforcement** — permission resolution, secret resolution, audit chain, approval gating.
- **Process & session lifecycle** — supervises resident coding agents (e.g. `opencode serve`), spawns ephemeral agents per step, persists ACP sessions across restarts.
- **HTTP surface** — sync / async runs, SSE event streams, idempotency, approvals, sessions.
- **Scheduler** — fires cron / matrix / slack / webhook triggers into registered workflows.

The gateway is consumed via the `skelm` CLI:

```bash
skelm gateway start --foreground   # run the gateway in this process
skelm gateway start --detach       # fork a foreground gateway
skelm gateway status
skelm gateway stop
```

There is no separate `skelm-gateway` executable — the gateway always runs from the single `skelm` bin.

## Status

Phase 0 scaffold. Subsequent phases populate the package; see `planning/21-gateway-and-deployment.md` for design.
