# Delegation (multi-agent orchestration)

Delegation lets one agent hand a task to another agent — or a whole pipeline — **mid-turn**, wait for the result, and keep going. It is the primitive you build router/specialist architectures on: a front-line agent that triages a request and dispatches it to the right specialist, a planner that fans work out to workers, an assistant that calls a sandboxed sub-agent for risky steps.

Skelm already lets a pipeline run another pipeline at the *step* level via [`invoke()` / `pipelineStep()`](/concepts/registries). Delegation is the *agent-level* counterpart: a built-in `delegate` tool the model can call during its own reasoning loop.

## The model

- **Targets are pipeline ids.** A one-agent pipeline *is* a named agent. The `delegate` tool resolves its target through the same gateway pipeline registry that `invoke()` uses — no separate agent registry.
- **It is synchronous fire-and-collect.** The delegating agent's turn blocks until the child run reaches a terminal state, then receives a structured envelope.
- **The child is bounded by the parent.** This is the security crux — see below.

## Using it

Grant the delegating agent a `delegation` allowlist (default-deny — omitting it means the agent cannot delegate to anything):

```ts
agent({
  id: 'router',
  backend: 'skelm-agent',
  prompt: (ctx) => ctx.input.message,
  permissions: {
    allowedTools: ['*'],
    // Which agents/pipelines this agent may hand off to. Matched like
    // allowedTools: exact ids, `foo.*` prefixes, or `*`.
    delegation: ['research.agent', 'specialists.*'],
  },
})
```

The model calls the `delegate` tool with a target id and an input:

```jsonc
// tool call the model emits
{ "name": "delegate", "arguments": { "agentId": "research.agent", "input": { "topic": "..." } } }
```

and gets back a structured envelope it can reason about:

```jsonc
{ "status": "completed", "runId": "…", "output": { /* the child's output */ } }
// or
{ "status": "failed", "runId": "…", "error": "…" }
```

A `failed` envelope is a *result*, not a tool error — the router can inspect `status` and retry, route elsewhere, or report. Denials (target not on the allowlist), an unwired runtime, and refused delegations (cycles / excess depth) come back as `isError` tool results so the model adapts rather than crashing.

## Permission bounding — a delegated child can never exceed its parent

Delegation is a security event: it lets one agent trigger another privileged run. The invariant is **non-escalation** — a delegated child's effective permissions are always a subset of the delegating agent's.

The runtime enforces this by passing the delegating agent's *resolved* policy down as the child run's **ceiling**. Every step in the child run (and any further delegations it makes) has its resolved policy intersected with that ceiling via `intersectResolvedPolicies`:

- Allowlists (tools, executables, MCP servers, skills, secrets, fs roots, network hosts, **delegation targets**) intersect — the child can only ever have less.
- Denylists and approval gating **union** — they only tighten down the chain.
- A child that declares *no* policy is capped at the ceiling rather than falling back to a backend's permissive default, closing that escape.
- `unrestricted` follows the parent: an unrestricted parent fully empowers the children it delegates to (a deliberate, operator-gated choice — the [unrestricted bypass](/concepts/permissions) already requires a two-key grant); a restricted parent caps any child grant — including a child's own unrestricted request — to normal enforcement.

Because the child's `delegation` allowlist is itself intersected with the parent's, the set of reachable agents can only shrink as you go deeper — the delegation graph is monotonically narrowing.

Coverage: `packages/core/test/security/delegation-default-deny.test.ts` (default-deny) and `packages/core/test/security/delegation-bounding.test.ts` (a child declaring `allowedTools: ['*']` under a scoped parent ends up scoped; re-delegation cannot widen).

## Safety: cycles and depth

A runaway router could otherwise delegate forever. Two guards prevent that:

- **Cycle detection.** Each run carries a delegation call-stack seeded with the top-level pipeline id; delegating to an id already on the stack throws `DelegationCycleError`.
- **Depth cap.** A chain deeper than `DEFAULT_MAX_DELEGATION_DEPTH` (8) throws `DelegationDepthError`.

Both fire *before* any child run starts, and surface to the model as an `isError` tool result.

## What flows through; what doesn't

The child run reuses the parent's runtime wiring — the same run store, state store, secret resolver, workspace manager, and the single gateway audit writer (delegation does **not** introduce a second audit writer or a new subprocess). Nested-run events publish on the same event bus, so a delegated run is observable like any other.

Out of scope for now: a named-agent registry with friendly handles, streaming a child's partial output back into the parent's turn, and delegating *into* a live [persistent-workflow](/concepts/persistent-workflows) session. Today's delegation is fire-and-collect against a pipeline id.
