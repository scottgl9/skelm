# In-workflow orchestration

A parent workflow (`orchestration-triage`) that drives child workflows from a
`code()` step:

- `ctx.workflows.invoke` runs the `orchestration-summary` child synchronously
  and adopts its typed result envelope.
- `ctx.workflows.fanout` scans every report concurrently through
  `orchestration-scan` with the `best-effort` strategy — corrupt reports are
  recorded as failures while the rest still complete.

## Permission ceilings

The orchestrating step declares

```ts
permissions: {
  delegation: ['orchestration-summary', 'orchestration-scan'],
}
```

Orchestration is default-deny: without that allowlist, `invoke`, `fanout`, and
`ctx.tasks.spawn` all refuse to start a child. Every child also runs under the
calling step's resolved policy as its **delegation ceiling** — whatever the
child declares for itself is intersected with the parent's policy, so a child
(or a detached task) can never exceed the parent that started it.

## Run it

```bash
cd examples/orchestration
skelm run triage.workflow.mts --input '{"reports":["all good","error: disk full\nerror: again","corrupt blob"]}'
```

Expected output: one scanned report with 2 errors, one clean report, and one
unreadable (corrupt) report recorded as a failure.
