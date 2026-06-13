# Human-in-the-loop (HITL) gates

A **HITL gate** is a durable pause point that suspends a run awaiting a human
decision. Gates are the runtime-level primitive that controls whether a step's
work proceeds, what value flows into it, or what happens to its output — under a
human's explicit choice.

Gates are built on the same durable wait/resume machinery that backs
[`wait()`](./orchestration): the pending gate is persisted on the run's
`waiting` snapshot, so it **survives a gateway restart** and stays resolvable.
While parked, the step consumes no resources.

## Authoring

Declare gates on a step with `humanInLoop`, and a workflow-level default on the
pipeline:

```ts
pipeline({
  id: 'risky-flow',
  // Workflow default: a step's own humanInLoop wins per phase.
  humanInLoop: { beforeRun: { kind: 'approval', reason: 'review before any step' } },
  steps: [
    code({
      id: 'deploy',
      humanInLoop: {
        beforeRun: { kind: 'approval', reason: 'deploy to production?' },
        afterOutput: { kind: 'validate', onReject: 'retry' },
      },
      run: async (ctx) => deploy(ctx.input),
    }),
  ],
})
```

- `beforeRun` fires **before** the step body runs.
- `afterOutput` fires **after** the body produces output, with the output
  available to the gate.

## Gate kinds

| `kind` | Decision | Effect |
|--------|----------|--------|
| `approval` | approve / deny | deny → step fails (`HitlDeniedError`); approve → proceeds |
| `input` | submit a value | value injected into `ctx.hitl.input` (validated against `schema` if set) |
| `edit` | submit an edited value | replaces the step's output (`afterOutput`) |
| `validate` | accept / reject | reject → fail, or re-run the body when `onReject: 'retry'` |
| `choose` | select option id(s) | selection in `ctx.hitl.choose`; `multi` allows choosing many |
| `retry-skip-abort` | retry / skip / abort | skip → body skipped; abort → step fails; retry → re-run body |

Common fields on every gate: `reason?`, `approvers?` / `assignees?`,
`options?` (choose), `timeoutMs?`, `onTimeout`, `escalation?`, `deliveryTarget?`.

Supported phase/kind combinations are explicit:

- `beforeRun`: `approval`, `input`, `choose`, `validate`, `retry-skip-abort`
- `afterOutput`: `approval`, `edit`, `validate`, `retry-skip-abort`

`edit` is only meaningful after output exists, while `input` and `choose` only
affect a step before the body runs. Unsupported combinations fail the step with
`HitlUnsupportedGatePhaseError` instead of silently doing nothing.

### Timeouts and escalation

`timeoutMs` bounds the wait; `onTimeout` decides what happens when it elapses:

- `fail` (default) — the step fails, the action is blocked.
- `approve` — proceed without a human.
- `deny` — the action is blocked (step fails).
- `escalate` — re-pause once under `escalation` (reassign `assignees`, notify
  `deliveryTarget`, optional secondary `timeoutMs`), then apply the escalation's
  terminal `onTimeout`.

## Resolving a gate

The gateway exposes the gate over its HTTP control surface:

```
GET  /v1/hitl                  # list pending gates
GET  /v1/hitl/:runId           # one pending gate
POST /v1/hitl/:runId/resolve   # resolve with a typed decision
```

The resolve body's `decision` verb must match the gate kind:

| Gate kind | Accepted `decision` verbs |
|-----------|---------------------------|
| `approval` / `validate` | `approve`, `deny` |
| `input` | `submit-input` (+ `value`) |
| `edit` | `submit-edit` (+ `value`) |
| `choose` | `choose` (+ `selected: string[]`) |
| `retry-skip-abort` | `retry`, `skip`, `abort` |

A mismatched verb is rejected with `400` and the run stays parked. Every
resolution is written to the single gateway audit writer as `hitl.<decision>`
with the actor, reason, run id, step id, gate kind, and delivery target.
Submitted `input` / `edit` **values are never audited**, since they may carry
secret material. The same applies to `run.resumed`: for `input` / `edit`, the
event carries a redacted marker and metadata only, not the submitted value.

## Policy-required gates (default-deny)

A gate can be **required** by the trust boundary — not just authored. A
`hitlPolicy` hook supplied to the gateway inspects each step (its risk signals:
risky executables, executable profiles, network egress, tool dispatch,
fs-write, production environment, …) and may inject a required gate the author
did not declare:

```ts
new Gateway({
  hitlEnvironment: 'production',
  hitlPolicy: (ctx) =>
    ctx.environment === 'production' && ctx.risk?.networkEgress
      ? { kind: 'approval', reason: 'egress in production requires sign-off' }
      : undefined,
})
```

A required gate **cannot be bypassed**:

- The gated action does not run until the gate is resolved.
- A required gate takes precedence over an author-declared gate for the same
  phase — author config cannot weaken the trust boundary's requirement.
- If no wait/resume handler is wired, a required gate **fails the step**
  (`HitlConfigError`) rather than silently proceeding — default-deny.

## Durability

A parked gate persists as `run.waiting.hitl` on the run record. After a gateway
restart the run is still `waiting` (recovery never finalizes a `waiting` run),
the gate appears in `GET /v1/hitl`, and `POST /v1/hitl/:runId/resolve`
rehydrates the run from its stored workflow path and drives it forward.

> Note: an `afterOutput` gate re-runs the step body on resume after a restart
> (the body output is recomputed). Prefer `beforeRun` gates on side-effectful
> steps, or make the body idempotent.
