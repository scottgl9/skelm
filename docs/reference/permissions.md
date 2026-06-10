# Permissions Reference

## Principle: default-deny

Every `AgentPermissions` field defaults to `undefined`, which the runtime treats as **deny**. An agent step with no `permissions` block cannot do anything privileged.

## The dimensions

```ts
interface AgentPermissions {
  profile?: string                            // named profile from skelm.config.ts
  allowedTools?: ToolMatcher                  // tools agent may call
  deniedTools?: ToolMatcher                   // tools explicitly blocked
  allowDefaultSafeExecutables?: boolean       // add skelm's built-in safe exec set
  allowedExecutables?: readonly string[]      // binaries for exec/bash
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

## Default safe executables

`allowDefaultSafeExecutables: true` opts a permission layer into skelm's built-in list of common Linux diagnostics and userland commands:

```ts
defaults: {
  permissions: {
    allowDefaultSafeExecutables: true,
    allowedExecutables: ['pnpm'], // optional project-specific additions
  },
}
```

The built-in set is:

```ts
[
  'awk', 'basename', 'cat', 'curl', 'cut', 'date', 'df', 'dirname',
  'dmesg', 'du', 'echo', 'env', 'file', 'find', 'free', 'gh', 'git',
  'grep', 'groups', 'head', 'hostname', 'id', 'journalctl', 'jq', 'ls',
  'lsof', 'mkdir', 'openssl', 'pgrep', 'printenv', 'ps', 'pwd',
  'readlink', 'realpath', 'rg', 'sed', 'sort', 'stat', 'systemctl',
  'tail', 'test', 'timeout', 'tr', 'uname', 'uniq', 'uptime', 'wc',
  'which', 'who', 'whoami',
]
```

The flag is explicit and layer-local. It adds that list to the same layer's `allowedExecutables` before the normal intersection runs, so custom additions compose and later layers can still narrow:

```ts
defaults: {
  permissions: {
    allowDefaultSafeExecutables: true,
    allowedExecutables: ['pnpm'],
  },
}

agent({
  permissions: {
    allowedExecutables: ['git', 'pnpm'], // narrows to these two
  },
})
```

Omitting the flag preserves default-deny. Shells, interpreters, deletion tools, and privilege escalation commands are intentionally not in the built-in set; grant them manually only when the step truly needs them.

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
