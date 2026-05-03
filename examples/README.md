# skelm examples

Runnable workflow examples. Each subdirectory is a self-contained workflow you can run with `skelm`. All examples use only step kinds available in the current MVP (today: `code()`).

| Example                 | What it shows                                                       |
| ----------------------- | ------------------------------------------------------------------- |
| `hello/`                | One-step greeting with a Zod input schema.                          |
| `sum/`                  | Multi-step: typed `ctx.steps[id]` flowing through three code steps. |
| `permissions-demo/`     | Enforcer usage in a `code()` step against a deny-all policy.        |

## Run

From the repo root:

```sh
pnpm build
node packages/skelm/dist/bin.js run examples/hello/hello.workflow.ts --input '{"name":"world"}'
node packages/skelm/dist/bin.js run examples/sum/sum.workflow.ts --input '{"a":2,"b":3}'
node packages/skelm/dist/bin.js run examples/permissions-demo/demo.workflow.ts --input '{}'
```

Once `skelm` is installed globally (`npm i -g skelm`), the same commands shorten to `skelm run examples/...`.
