# Guardrails & Oversight

Guardrails are a **run/workflow-level** oversight layer that sits above the
per-agent-loop safety checks. Where the native `@skelm/agent` harness enforces
budgets and validators inside a single agent turn loop, guardrails govern the
whole run: they validate before it starts, watch it while it runs, and validate
its result — producing structured, audited results the dashboard run inspector
and the audit log can show.

A guardrail config is declared on a workflow (`pipeline({ guardrails: … })`) and
may be **overlaid by the trust boundary** (gateway) via a policy hook so the
operator can inject mandatory checks an author cannot remove. Every field is
optional; an empty config changes nothing.

```ts
import { pipeline, code } from '@skelm/core'

const wf = pipeline({
  id: 'release',
  guardrails: {
    preRun: [modelAllowlistCheck, requiredApprovalCheck],
    budget: { tokenBudget: 200_000, maxToolCalls: 50 },
    budgetOnBreach: 'pause',
    watchdog: { maxRunMs: 30 * 60_000, maxIdleMs: 5 * 60_000, onBreach: 'terminate' },
    supervisor: critic,
    postRun: [outputSchemaCheck, qualityScore],
  },
  steps: [/* … */],
})
```

## The three phases

### 1. Pre-run validators (fail closed)

Pre-run validators run **before the first step body executes**. Use them for
workflow/package policy checks, effective-permission review (inspecting the
resolved policy), model/provider allowlists, executable-profile review, and
required-approval checks.

- A **hard** failure (the default severity) throws `GuardrailBlockedError` and
  **blocks the run start** — no step runs. This is fail-closed by design: a
  guardrail can never be bypassed by a step that would otherwise execute.
- A **soft** failure records a warning and the run proceeds.
- A validator that **throws** is treated as a hard failure.

Each result is emitted as a `guardrail.pre` event and audited.

```ts
const modelAllowlistCheck: PreRunValidator = {
  id: 'model-allowlist',
  validate: (ctx) => {
    // ctx.resolvedPolicies, ctx.environment, ctx.input are available for review.
    return allowed
      ? { check: 'model-allowlist', status: 'pass' }
      : { check: 'model-allowlist', status: 'fail', message: 'provider not allowlisted' }
  },
}
```

### 2. In-run oversight

While the run executes, guardrails apply between steps:

- **Budgets** reuse the core `AgentBudget` tracker — the *same* accounting used
  by the agent harness, not a parallel implementation. A run-level budget caps
  cumulative tokens, estimated cost, tool calls, and wall-clock across the whole
  run. Tool calls are counted from `tool.call` events; token/cost usage is
  folded from agent step output. A breach raises `budgetOnBreach`.
- The **watchdog** bounds total wall-clock (`maxRunMs`) and idle time between
  steps (`maxIdleMs`). A breach raises `onBreach`.
- The **supervisor/critic** is an optional callback invoked after each step with
  a progress snapshot (last step, cumulative usage). It may return an
  intervention request. It is a pure hook — an LLM-backed critic lives outside
  the runtime and feeds its decision in through this callback.

#### Interventions

An intervention is one of three actions, realized by **reusing existing
primitives**:

| Action      | Mechanism                                                              |
| ----------- | --------------------------------------------------------------------- |
| `pause`     | a durable [HITL](./human-in-the-loop.md) gate that blocks until resolved |
| `escalate`  | a HITL gate with escalation semantics                                 |
| `terminate` | cancels the run (aborts its signal)                                   |

A `pause`/`escalate` with **no wait/resume handler wired fails closed** — it
degrades to terminate rather than silently continuing past the hold. A rejected
oversight gate also terminates the run. Every intervention is emitted as a
`guardrail.intervention` event (carrying `action`, `source`, and a non-secret
`reason`) and audited.

### 3. Post-run validators

After the run produces its output, post-run validators check output schema,
expected-behavior assertions, artifact presence, and an optional 0..1 quality
score. A **hard** post-run failure marks the run **guardrail-failed**: the run's
status becomes `failed` and a report is recorded on the run record
(`Run.guardrail`). Each result is emitted as `guardrail.post` and audited.

## Dashboard & audit visibility

Guardrails are observable end to end:

- **Events** — `guardrail.pre`, `guardrail.post`, and `guardrail.intervention`
  ride the run event bus, so the dashboard run inspector can show guardrail
  status, validation failures, oversight interventions, and budget consumption
  live.
- **Run record** — `Run.guardrail` carries a durable `RunGuardrailReport`
  (`failed`, every pre/post `results`, and recorded `interventions`).
- **Audit** — every guardrail decision and intervention is written through the
  single gateway audit writer.

Guardrail messages, details, and scores **must never carry secret values** — a
validator may inspect a secret internally, but only a non-secret reason reaches
events, the report, or the audit log.

## Policy overlay (trust boundary)

The gateway can supply a `GuardrailsPolicy`: given a workflow's authored config
it returns the config the runtime enforces. Use it to inject mandatory pre/post
validators, a budget ceiling, or a watchdog the author cannot remove. The
overlay's result is authoritative — it wins over the author's config.

## Relationship to other primitives

- **Agent budgets/validators** (`@skelm/agent`) gate a single agent loop;
  guardrail budgets gate the whole run using the same tracker. They compose.
- **HITL gates** (`humanInLoop` on steps/workflows) are author-declared pause
  points; oversight interventions reuse the same durable gate machinery to pause
  or escalate a run dynamically.
- **Permissions** decide what a step *may* do (default-deny); guardrails decide
  whether the run as a whole is allowed to start, continue, and finish.
