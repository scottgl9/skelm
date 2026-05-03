# Guide — testing workflows

Customers writing skelm workflows are writing TypeScript modules. The testing story is "test them like any other TypeScript code" — but skelm gives you specific tools that make it easy to exercise the runtime without standing up a gateway, mocking the network, or spinning up a real LLM.

## What to test

Three layers, in priority order:

1. **Workflow logic** — does the workflow produce the right output for representative inputs?
2. **Step contracts** — does each step's output match its declared schema given controlled inputs?
3. **Permission posture** — does the workflow refuse to start (or the step refuse to run) when permissions are violated?

Customer workflows ship to production with all three layers covered or they should not ship.

## The in-process runner

`@skelm/core` exports a factory for running workflows in tests without a gateway service:

```ts
import { createInProcessContext, Runner } from '@skelm/core'
import workflow from './my.workflow.ts'

const context = await createInProcessContext({
  inMemory: true,                  // run store + state in memory; no SQLite
  backends: [
    /* fixture backends — see below */
  ],
})
const runner = new Runner(context)

const run = await runner.start(workflow, { /* input */ }).wait()
expect(run.status).toBe('completed')
expect(run.output).toMatchObject({ /* expected */ })
```

`createInProcessContext({ inMemory: true })` builds the same `RuntimeContext` the gateway builds, with two differences:

- The run store is in-memory; nothing persists.
- No HTTP listener, no scheduler.

The trust boundary is the same. Permission enforcement runs in tests just like in production.

## Fixture backends

For LLM and agent steps, real backends in tests are slow, flaky, and expensive. Skelm exports `fixtureBackend` for deterministic tests:

```ts
import { fixtureBackend } from '@skelm/core/testing'

const fakeAnthropic = fixtureBackend({
  id: 'anthropic',
  capabilities: { /* matches real backend */ },
  responses: {
    'classify-one': (req) => ({
      output: { label: 'bug', reasoning: 'crash report' },
      usage: { inputTokens: 100, outputTokens: 20 },
    }),
  },
})
```

The fixture backend:

- Implements `SkelmBackend` with `infer` (and optionally `run`) returning controlled outputs.
- Matches by step `id` so each step gets its scripted response.
- Validates the request matches what the step's prompt would produce (catches prompt drift).
- Records every call so tests can assert on inputs.

For `agent()` steps, fixture backends script multi-turn behavior:

```ts
const fakeAcp = fixtureBackend({
  id: 'copilot-acp',
  capabilities: { /* ... */ },
  agentRuns: {
    'classify': [
      { tool: 'gh.list_issues', args: { repo: 'acme/x' }, response: [/* mocked */] },
      { final: { label: 'bug', reasoning: 'crash report' } },
    ],
  },
})
```

## Asserting on events

Every run emits a typed event stream. Tests can subscribe:

```ts
const events: RunEvent[] = []
const handle = runner.start(workflow, input)
const unsub = context.events.forRun(handle.runId, (e) => events.push(e))
const run = await handle.wait()
unsub()

const stepStarts = events.filter((e) => e.type === 'step.start')
expect(stepStarts.map((e) => e.stepId)).toEqual(['fetch', 'classify', 'route', 'notify'])

const denials = events.filter((e) => e.type === 'permission.denied')
expect(denials).toHaveLength(0)
```

This is how you assert ordering, parallelism, and that no permission denial slipped through unnoticed.

## Testing permissions (the security tenet at the customer level)

For every workflow with permission-bearing steps, ship at least one **permission test** that asserts the deny path:

```ts
test('agent cannot exec arbitrary binaries', async () => {
  const malicious = fixtureBackend({
    id: 'copilot-acp',
    capabilities: { /* ... */ },
    agentRuns: {
      'work': [
        // This call SHOULD be denied because 'rm' is not in allowedExecutables
        { tool: 'exec', args: { command: 'rm', args: ['-rf', '/'] } },
      ],
    },
  })

  const ctx = await createInProcessContext({ inMemory: true, backends: [malicious] })
  const runner = new Runner(ctx)
  const events: RunEvent[] = []
  const handle = runner.start(myWorkflow, sampleInput)
  ctx.events.forRun(handle.runId, (e) => events.push(e))

  await handle.wait()

  expect(events.some((e) => e.type === 'tool.denied' && (e as any).tool === 'exec')).toBe(true)
})
```

This pattern catches accidental permission widening when the workflow is edited later. If a future change to the workflow adds `'rm'` to `allowedExecutables`, this test fails — exactly the moment a human should review the change.

## Snapshot the inspectable graph

Workflows have a static graph (`Pipeline.graph`). Snapshot it in tests so adding/removing/reordering steps is a visible diff:

```ts
import { renderGraph } from '@skelm/core/graph'

test('workflow shape is stable', () => {
  expect(renderGraph(workflow.graph, 'mermaid')).toMatchSnapshot()
})
```

Useful when a workflow grows over time and you want PRs that change shape to require explicit acknowledgement.

## Testing `wait()` steps

`wait()` suspends the run waiting for input. In tests:

```ts
const handle = runner.start(workflow, input)

// Wait until the run reaches the wait step
await waitForEvent(ctx.events, handle.runId, 'run.waiting')

// Provide the resume input
await runner.resume(handle.runId, { approved: true })

const run = await handle.wait()
expect(run.status).toBe('completed')
```

`waitForEvent` is a small helper exported from `@skelm/core/testing`.

## Testing scheduler-driven workflows

If your workflow only makes sense under a schedule (cron, webhook, poll), test the workflow logic separately from the schedule. The workflow is a pure function of input → output; the schedule is a separate concern handled by integration tests against a real gateway.

For schedule integration tests:

```ts
import { createTestGateway } from '@skelm/gateway/testing'

test('cron schedule fires the workflow at the expected time', async () => {
  const gateway = await createTestGateway({ time: 'mock' })
  await gateway.scheduleAdd({ workflowId: 'foo', trigger: { kind: 'cron', expression: '0 * * * *' } })
  await gateway.advanceClock('1 hour')
  const runs = await gateway.runs.list({ workflowId: 'foo' })
  expect(runs).toHaveLength(1)
  await gateway.stop()
})
```

Test gateways spin up in under 100ms because they use the in-memory run store and a mockable clock.

## CI integration

```json
// package.json
{
  "scripts": {
    "test": "vitest run",
    "test:perms": "vitest run tests/permissions/"
  }
}
```

Two suites: regular tests and a dedicated permission-test suite. CI runs both. Permission failures are higher-priority than functional failures; flagging them separately surfaces the security signal.

## What NOT to test

- The framework itself. `@skelm/core`'s tests cover the runner, dispatcher, and trust boundary. Customer tests cover customer logic.
- Network calls inside `code()` steps that just hit the network. Those are integration tests, run separately with real services.
- Backend internals. Use fixture backends in unit tests; pin a recorded fixture in one integration test for the real backend if you want a contract check.

## Recommended structure

```
my-skelm-project/
├── workflows/
│   └── triage.workflow.ts
├── tests/
│   ├── triage.test.ts             # workflow logic
│   ├── permissions/
│   │   └── triage.deny.test.ts    # permission deny-path tests
│   └── integration/
│       └── triage.real.test.ts    # against real backends, marked .skip in regular runs
└── package.json
```

## Cross-references

- [API → testing](../reference/api.md#testing) — `createInProcessContext`, `fixtureBackend`, `createTestGateway`.
- [Concepts → permissions](../concepts/permissions.md) — what default-deny means in practice.
- [Concepts → runs](../concepts/runs.md) — event stream and lifecycle the tests assert against.
