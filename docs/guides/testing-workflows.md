# Guide — testing workflows

Customers writing skelm workflows are writing TypeScript modules. The testing story is "test them like any other TypeScript code" — but skelm gives you specific tools that make it easy to exercise the runtime without standing up a gateway, mocking the network, or spinning up a real LLM.

## What to test

Three layers, in priority order:

1. **Workflow logic** — does the workflow produce the right output for representative inputs?
2. **Step contracts** — does each step's output match its declared schema given controlled inputs?
3. **Permission posture** — does the workflow refuse to start (or the step refuse to run) when permissions are violated?

Customer workflows ship to production with all three layers covered or they should not ship.

## Running a workflow in a test

`@skelm/core` ships two ways to run workflows without a gateway service.

The simpler one — `runPipeline` — is best for end-to-end assertions:

```ts
import { BackendRegistry, runPipeline } from '@skelm/core'
import workflow from './my.workflow.mts'
// import fixture backends as needed (see below)

const backends = new BackendRegistry()
// backends.register(...)

const run = await runPipeline(workflow, { /* input */ }, { backends })
expect(run.status).toBe('completed')
expect(run.output).toMatchObject({ /* expected */ })
```

For finer control (custom enforcement, event subscription, manual `start` + `wait`), construct a `Runner` directly:

```ts
import { Runner, BackendRegistry } from '@skelm/core'

const runner = new Runner({
  backends: new BackendRegistry(),
  // auditWriter, secretResolver, approvalGate — defaults are test-friendly
})
const run = await runner.start(workflow, { /* input */ }).wait()
```

Both paths run the same trust-boundary code that the gateway uses; permission enforcement fires in tests just like in production.

## Fixture backends

For LLM and agent steps, real backends in tests are slow, flaky, and expensive. `@skelm/core/testing` exports `fixtureBackend` for deterministic tests:

```ts
import { fixtureBackend } from '@skelm/core/testing'

const fakeOpenAI = fixtureBackend({
  id: 'openai',
  // capabilities defaults to { prompt: true, ... }; pass overrides to widen.
  respond: (req) => {
    // Inspect req.messages, req.system, req.outputSchema to branch.
    return {
      structured: { label: 'bug', reasoning: 'crash report' },
      usage: { inputTokens: 100, outputTokens: 20 },
    }
  },
})

// fakeOpenAI.calls is a readonly array of every InferRequest received,
// useful for asserting prompt content.
expect(fakeOpenAI.calls).toHaveLength(1)
expect(fakeOpenAI.calls[0]?.messages[0]?.content).toContain('bug')
```

The fixture backend:

- Implements `SkelmBackend.infer` and returns whatever `respond(req)` produces.
- Records every call so tests can assert on inputs.
- For `agent()` steps that need multi-turn behaviour, write a real backend stub: implement `run(request, context)` and return an `AgentResponse` directly.

## Asserting on events

Every run emits a typed event stream via `Runner.events` (an `EventBus`):

```ts
import { Runner, type RunEvent } from '@skelm/core'

const runner = new Runner({ backends })
const events: RunEvent[] = []
const unsub = runner.events.subscribe((e) => events.push(e))

const handle = runner.start(workflow, input)
const run = await handle.wait()
unsub()

const stepStarts = events.filter((e) => e.type === 'step.started')
expect(stepStarts.map((e) => e.stepId)).toEqual(['fetch', 'classify', 'route', 'notify'])

const denials = events.filter((e) => e.type === 'permission.denied')
expect(denials).toHaveLength(0)

// Streaming backends emit one event per delta — useful for asserting the
// streaming path actually fires rather than coercing to a single round-trip.
const partials = events.filter((e) => e.type === 'step.partial')
expect(partials.length).toBeGreaterThan(0)
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

  const backends = new BackendRegistry()
  backends.register(malicious)
  const runner = new Runner({ backends })
  const events: RunEvent[] = []
  runner.events.subscribe((e) => events.push(e))
  const handle = runner.start(myWorkflow, sampleInput)

  await handle.wait()

  expect(events.some((e) => e.type === 'tool.denied' && (e as any).tool === 'exec')).toBe(true)
})
```

This pattern catches accidental permission widening when the workflow is edited later. If a future change to the workflow adds `'rm'` to `allowedExecutables`, this test fails — exactly the moment a human should review the change.

## Snapshot the inspectable graph

Workflows have an introspectable description; snapshot it in tests so adding/removing/reordering steps is a visible diff:

```ts
import { describePipeline } from '@skelm/core'

test('workflow shape is stable', () => {
  expect(describePipeline(workflow)).toMatchSnapshot()
})
```

Useful when a workflow grows over time and you want PRs that change shape to require explicit acknowledgement.

## Testing `wait()` steps

`wait()` suspends the run waiting for input. In tests:

```ts
const handle = runner.start(workflow, input)

// Drive the run forward until it suspends; subscribe to events to know when.
runner.events.subscribe((e) => {
  if (e.type === 'step.suspended') {
    void runner.resume(handle.runId, { approved: true })
  }
})

const run = await handle.wait()
expect(run.status).toBe('completed')
```

## Testing scheduler-driven workflows

If your workflow only makes sense under a schedule (cron, webhook, poll), test the workflow logic separately from the schedule. The workflow is a pure function of input → output; the schedule is a separate concern.

For schedule integration tests, drive the gateway directly via its public types in `@skelm/gateway` and the trigger primitives from `@skelm/scheduler` — there is no separate "test gateway" factory.

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
│   └── triage.workflow.mts
├── tests/
│   ├── triage.test.ts             # workflow logic
│   ├── permissions/
│   │   └── triage.deny.test.ts    # permission deny-path tests
│   └── integration/
│       └── triage.real.test.ts    # against real backends, marked .skip in regular runs
└── package.json
```

## Cross-references

- [API → testing](../reference/api.md) — `runPipeline`, `Runner`, `BackendRegistry`, `fixtureBackend`.
- [Concepts → permissions](../concepts/permissions.md) — what default-deny means in practice.
