# Running external scripts from `code()` steps

A `code()` step can spawn external executables — binaries on `$PATH`, Python scripts, or Bash scripts — via the `ctx.exec(...)` helper. Every call is checked against the step's `permissions.allowedExecutables` allowlist. Omitting the field denies every call (default-deny).

## A Python script

```ts
import { code, pipeline } from 'skelm'

export default pipeline({
  id: 'report',
  steps: [
    code({
      id: 'render',
      permissions: { allowedExecutables: ['python3'] },
      run: async (ctx) => {
        const r = await ctx.exec!({
          python: './scripts/render.py',
          args: ['--input', ctx.workspace?.path ?? '.'],
          timeoutMs: 30_000,
        })
        if (r.exitCode !== 0) {
          throw new Error(`render failed: ${r.stderr}`)
        }
        return { html: r.stdout }
      },
    }),
  ],
})
```

The `python:` shortcut runs `$SKELM_PYTHON` (default `python3`) with the script as the first argv. Override the interpreter via env (e.g. for a venv: `SKELM_PYTHON=/srv/app/.venv/bin/python skelm run pipeline.ts`). Whichever interpreter is resolved is what the allowlist checks against — so `python3` here, not `./scripts/render.py`.

## A Bash script

```ts
code({
  id: 'build',
  permissions: { allowedExecutables: ['bash'] },
  run: async (ctx) =>
    await ctx.exec!({
      bash: './scripts/build.sh',
      env: { CI: '1' },
      throwOnNonZero: true,
    }),
})
```

`throwOnNonZero: true` upgrades non-zero exits to thrown errors so the step fails fast.

## A native binary

```ts
code({
  id: 'commit-sha',
  permissions: { allowedExecutables: ['git'] },
  run: async (ctx) => {
    const r = await ctx.exec!({ command: 'git', args: ['rev-parse', 'HEAD'] })
    return r.stdout.trim()
  },
})
```

## Permission failure surface

When the allowlist denies a call, the step fails with `PermissionDeniedError`:

```
PermissionDeniedError: exec denied: "python3" not in allowedExecutables (reason: not-in-allowlist)
```

Audit consumers receive the matching `permission.denied` event with `dimension: 'executable'`. See [permissions reference](../reference/permissions.md#code-step-permissions) for the full model and [pipeline-authoring](../reference/pipeline-authoring.md#spawning-external-executables--ctxexec) for the full `ExecRequest` shape.

## Including helper modules

If the script you want to run is itself TypeScript and you'd rather call it in-process than spawn it, use `code({ module: ... })` instead — see [pipeline-authoring](../reference/pipeline-authoring.md#loading-the-run-function-from-a-file).
