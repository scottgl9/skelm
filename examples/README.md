# skelm examples

Runnable workflow examples. Each subdirectory is a self-contained workflow you can run with `skelm`.

| Example                  | What it shows                                                              |
| ------------------------ | -------------------------------------------------------------------------- |
| `hello/`                 | One-step greeting with a Zod input schema.                                 |
| `sum/`                   | Multi-step: typed `ctx.steps[id]` flowing through three code steps.        |
| `permissions-demo/`      | `TrustEnforcer` usage in a `code()` step against a deny-all policy.        |
| `multi-step-pipeline/`   | Sequential composition with branching/control flow.                        |
| `matrix-coding-agent/`   | Coding agent triggered from a Matrix room; demonstrates `agent()` + MCP.   |

## Run

From the repo root:

```sh
pnpm build
node packages/skelm/dist/bin.js run examples/hello/hello.workflow.ts --input '{"name":"world"}'
node packages/skelm/dist/bin.js run examples/sum/sum.workflow.ts --input '{"a":2,"b":3}'
node packages/skelm/dist/bin.js run examples/permissions-demo/demo.workflow.ts --input '{}'
node packages/skelm/dist/bin.js run examples/multi-step-pipeline/multi-step.workflow.ts --input '{"task":"investigate the login bug"}'
```

Once `skelm` is installed globally (`npm i -g skelm`), the same commands shorten to `skelm run examples/...`.

`matrix-coding-agent/` ships its own `skelm.config.ts` and requires a Matrix server plus an MCP tool stack — see its README for setup.
