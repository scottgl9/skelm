# Permissions Reference

## Principle: default-deny

Every `AgentPermissions` field defaults to `undefined`, which the runtime treats as **deny**. An agent step with no `permissions` block cannot do anything privileged.

## The dimensions

```ts
interface AgentPermissions {
  profile?: string                            // named profile from skelm.config.ts
  allowedTools?: ToolMatcher                  // tools agent may call
  deniedTools?: ToolMatcher                   // tools explicitly blocked
  allowedExecutables?: readonly string[]      // binaries for exec/bash
  executableProfiles?: readonly string[]      // named executable sets from skelm config
  allowedMcpServers?: readonly string[]       // MCP server ids from config
  allowedSkills?: readonly string[]           // skill ids agent may load
  allowedSecrets?: readonly string[]          // secret names the step may resolve
  networkEgress?: NetworkPolicy               // 'allow' | 'deny' | { allowHosts }
  fsRead?: readonly string[]                  // path roots agent may read
  fsWrite?: readonly string[]                 // path roots agent may write
  approval?: ApprovalPolicy                   // gates dimensions on human approval
}
```

`ApprovalPolicy` looks like:

```ts
interface ApprovalPolicy {
  on: readonly PermissionDimension[]    // which dimensions need approval
  rememberFor?: number                  // ms to cache an approval decision
}
```

The runtime calls `runtime.approvalGate.request(...)` at the start of every agent step whose resolved policy declares `approval`; a denial fails the step with `ApprovalDeniedError`.

## ToolMatcher

```ts
// Array form — preferred
allowedTools: ['gh.list_issues', 'gh.*', '*']

// Explicit shape
allowedTools: {
  exact: ['gh.list_issues'],
  prefixes: ['gh.'],    // note: stored without trailing dot
  star: false,
}
```

- `'*'` permits any tool id.
- `'gh.*'` permits any tool whose id starts with `gh.`.
- `deniedTools` uses **union** semantics (any deny match blocks the tool).
- `allowedTools` uses **intersection** semantics across layers.

## NetworkPolicy

```ts
type NetworkPolicy = 'allow' | 'deny' | { allowHosts: readonly string[] }
```

- `'allow'` — any outbound request is permitted.
- `'deny'` — all outbound requests are blocked.
- `{ allowHosts: ['api.github.com', 'registry.npmjs.org'] }` — hostname allowlist.

## Composition: intersection-only

Policy layers in order: **project defaults → named profile → step-level**.

At each boundary, the rule is: **the result is the intersection**. A step can narrow, never widen.

```
project defaults:  { networkEgress: 'deny', fsRead: ['./'] }
step permissions:  { networkEgress: 'allow', fsRead: ['./', '/tmp'] }
resolved policy:   { networkEgress: 'deny', fsRead: ['./'] }
```

The step's `'allow'` loses to the default `'deny'`. The `/tmp` fs-read root is dropped because it wasn't in the default.

## Named profiles

Declare profiles in `skelm.config.ts`:

```ts
defaults: {
  permissionProfiles: {
    'read-only': {
      fsRead: ['./'],
      fsWrite: [],
      networkEgress: 'deny',
      allowedTools: [],
    },
    'github-write': {
      fsRead: ['./'],
      fsWrite: ['./'],
      networkEgress: { allowHosts: ['api.github.com'] },
      allowedTools: ['gh.*'],
      allowedExecutables: ['git'],
      allowedMcpServers: ['github'],
    },
  },
}
```

Use in a step:

```ts
agent({
  id: 'implement',
  permissions: {
    profile: 'github-write',
    allowedTools: ['gh.list_issues', 'gh.create_pr'],  // further narrows from profile
  },
})
```

## Executable profiles

Executable profiles are operator-defined, named sets of executables that permissions reference by name instead of repeating `allowedExecutables` lists across workflows. Definitions live in config (`defaults.executableProfiles`); workflows can only *reference* a profile — they can never define or alter one.

```ts
// skelm.config.ts (or skelm.gateway.ts)
defaults: {
  executableProfiles: {
    linuxReadOnly: {
      description: 'read-only shell utilities',
      executables: ['ls', 'cat', 'rg', 'find', 'head', 'tail'],
      tags: ['read-only'],
    },
    gitReadOnly: { executables: ['git'] },
    nodeBuild: { executables: ['node', 'pnpm'] },
  },
}
```

These three are *documented examples*, not built-ins: no profile exists or is granted unless your config defines it **and** a permission layer references it by name. Default-deny holds — a step with no `executableProfiles` and no `allowedExecutables` has no executables at all.

Reference profiles from any permission layer:

```ts
agent({
  id: 'implement',
  permissions: {
    executableProfiles: ['gitReadOnly', 'nodeBuild'],
    allowedExecutables: ['git', 'node'],   // optional; narrows the expansion
  },
})
```

Resolution semantics:

- Within a layer, the referenced profiles expand to the **union** of their executables. An explicit `allowedExecutables` on the same layer then **intersects** with the expansion — it can only narrow, never widen. Above, `pnpm` is dropped because the explicit list excludes it.
- Across layers (project defaults → named permission profile → step-level), the usual intersection-only composition applies: a step-level profile reference can never widen past the project-default ceiling.
- Referencing a profile name the config does not define throws the typed `UnknownExecutableProfileError` **before the run starts** — `skelm validate` flags it statically (`unknown-executable-profile`), and every gateway run path rejects it at workflow load.
- The resolved policy records the applied names as `executableProfileNames` metadata for inspect/audit surfaces; enforcement reads only the expanded `allowedExecutables` set.

> **Caveat:** executable allowlists — profiles included — gate at the **binary** level only. Allowing `git` allows *every* git subcommand (`git push`, `git config`, …); a "read-only" profile name is documentation of intent, not a subcommand restriction.

## TrustEnforcer

`TrustEnforcer` is the single enforcement point. Every `canX` method returns a structured decision:

```ts
type EnforceDecision =
  | { allow: true }
  | { allow: false; reason: PermissionDenialReason; dimension: PermissionDimension }
```

Never branch on `AgentPermissions` fields directly in step code — call `TrustEnforcer` and let it return the decision. In production the gateway owns the enforcer instance; use it in tests to verify your permission config.

```ts
import { TrustEnforcer, resolvePermissions } from 'skelm'

const enforcer = new TrustEnforcer(resolvePermissions(projectDefaults, stepPermissions))
const decision = enforcer.canCallTool('gh.list_issues')
// { allow: true } or { allow: false, reason: 'not-in-allowlist', dimension: 'tool' }
```

## Code-step permissions

`code()` steps accept the same `permissions` shape as `agent()` steps, but only `allowedExecutables` is enforced today. The runner builds a `TrustEnforcer` for every `code()` step from `defaultPermissions` ∩ step-level `permissions` and uses it to gate `ctx.exec(...)`:

```ts
code({
  id: 'render',
  permissions: { allowedExecutables: ['python3'] },
  run: async (ctx) => ctx.exec!({ python: './render.py' }),
})
```

Default-deny applies: omitting `permissions` (or omitting `allowedExecutables`) denies every `ctx.exec` call with `PermissionDeniedError` and `dimension: 'executable'`. The check uses the basename of the resolved binary (`python3` / `bash` for the `python:` / `bash:` shortcuts), not the user's input string.

## Denial reasons

| Reason | Meaning |
|---|---|
| `'no-policy'` | No policy present (network deny) |
| `'not-in-allowlist'` | Target not in the allow set |
| `'in-denylist'` | Target matched `deniedTools` |
| `'host-not-allowed'` | Hostname not in `allowHosts` |
| `'path-not-in-allowlist'` | File path not under any allowed root (paths are normalized with `path.resolve` before the boundary check, so `..` segments cannot escape an allowed root) |
| `'star-disallowed-in-prod'` | `*` wildcard blocked in production mode |

## Testing permissions

Two fixtures are required for every permission dimension you touch:

1. **Default-deny fixture** — call `resolvePermissions(undefined, undefined)`, assert deny.
2. **Explicit-deny fixture** — construct a policy that should deny, assert denial with the expected `reason` and `dimension`.

Place adversarial tests in `packages/core/test/security/`.
