// AgentPermissions: the default-deny security model for agent steps.
//
// Authors declare what an agent step is allowed to do; the runtime resolves
// the final policy (project defaults + profile + step-level + workspace
// intersections) and enforces it through a single helper: TrustEnforcer.

import { PermissionDeniedError } from './errors.js'
//
// Backends and tools never branch on policy themselves — they call the
// helper, which returns a structured allow/deny decision and emits the
// matching audit + event payloads.

/** Dimensions of the permission model. Each defaults to deny when omitted. */
export type PermissionDimension =
  | 'tool'
  | 'executable'
  | 'mcp'
  | 'skill'
  | 'secret'
  | 'network'
  | 'fs.read'
  | 'fs.write'

/** Network egress policy. */
export type NetworkPolicy = 'allow' | 'deny' | { allowHosts: readonly string[] }

/** A tool matcher: explicit ids, prefix patterns, or `*` for everything. */
export type ToolMatcher =
  | readonly string[]
  | { exact?: readonly string[]; prefixes?: readonly string[]; star?: boolean }

/** Approval policy (deferred to a future stage; type carried for forward-compat). */
export interface ApprovalPolicy {
  /** Dimensions that gate on approval. */
  on: readonly PermissionDimension[]
  /** Cache duration after an approval is granted. */
  rememberFor?: number
}

/** What an `agent()` step author writes. Every field is optional; default is deny. */
export interface AgentPermissions {
  /** Named project profile applied before step-level narrowing. */
  profile?: string
  /** Tool ids the agent may call (e.g. `gh.list_issues`). */
  allowedTools?: ToolMatcher
  /** Tool ids explicitly forbidden even if `allowedTools` would permit. */
  deniedTools?: ToolMatcher
  /** Executables allowed for any exec/bash tool. */
  allowedExecutables?: readonly string[]
  /** MCP server ids permitted to attach. */
  allowedMcpServers?: readonly string[]
  /** Skill ids permitted to load. */
  allowedSkills?: readonly string[]
  /** Secret names the agent step is permitted to access. */
  allowedSecrets?: readonly string[]
  /** Network egress policy. */
  networkEgress?: NetworkPolicy
  /** Path roots the agent may read. */
  fsRead?: readonly string[]
  /** Path roots the agent may write. */
  fsWrite?: readonly string[]
  /** Approval gating policy. */
  approval?: ApprovalPolicy
}

/** A frozen, normalized policy ready for enforcement. Built by `resolvePermissions`. */
export interface ResolvedPolicy {
  readonly allowedTools: ResolvedToolMatcher
  readonly deniedTools: ResolvedToolMatcher
  readonly allowedExecutables: ReadonlySet<string>
  readonly allowedMcpServers: ReadonlySet<string>
  readonly allowedSkills: ReadonlySet<string>
  readonly allowedSecrets: ReadonlySet<string>
  readonly networkEgress: NetworkPolicy
  readonly fsRead: ReadonlySet<string>
  readonly fsWrite: ReadonlySet<string>
  readonly approval: ApprovalPolicy | null
}

/** Internal canonical shape of a tool matcher used for O(1) lookups. */
export interface ResolvedToolMatcher {
  readonly exact: ReadonlySet<string>
  readonly prefixes: readonly string[]
  readonly star: boolean
}

/** Reason a privileged action was denied; surfaced to event/audit payloads. */
export type PermissionDenialReason =
  | 'no-policy'
  | 'not-in-allowlist'
  | 'in-denylist'
  | 'host-not-allowed'
  | 'path-not-in-allowlist'
  | 'star-disallowed-in-prod'

/** Structured decision returned by every TrustEnforcer.canX method. */
export type EnforceDecision =
  | { allow: true }
  | { allow: false; reason: PermissionDenialReason; dimension: PermissionDimension }

const EMPTY_MATCHER: ResolvedToolMatcher = Object.freeze({
  exact: new Set<string>(),
  prefixes: Object.freeze([]),
  star: false,
})

/**
 * Resolve a permission policy from project defaults + step-level fields.
 * Intersection-only: nothing widens. The returned policy is immutable.
 */
export function resolvePermissions(
  defaults: AgentPermissions | undefined,
  stepLevel: AgentPermissions | undefined,
  profiles: Readonly<Record<string, AgentPermissions>> = {},
): ResolvedPolicy {
  const profile =
    stepLevel?.profile === undefined
      ? undefined
      : (profiles[stepLevel.profile] ??
        (() => {
          throw new Error(`unknown permission profile: ${stepLevel.profile}`)
        })())
  const inputs = [defaults, profile, stripProfile(stepLevel)].filter(
    (p): p is AgentPermissions => p !== undefined,
  )

  return Object.freeze({
    allowedTools: intersectToolMatchers(inputs.map((p) => p.allowedTools)),
    deniedTools: unionToolMatchers(inputs.map((p) => p.deniedTools)),
    allowedExecutables: intersectStrings(inputs.map((p) => p.allowedExecutables)),
    allowedMcpServers: intersectStrings(inputs.map((p) => p.allowedMcpServers)),
    allowedSkills: intersectStrings(inputs.map((p) => p.allowedSkills)),
    allowedSecrets: intersectStrings(inputs.map((p) => p.allowedSecrets)),
    networkEgress: intersectNetwork(inputs.map((p) => p.networkEgress)),
    fsRead: intersectStrings(inputs.map((p) => p.fsRead)),
    fsWrite: intersectStrings(inputs.map((p) => p.fsWrite)),
    approval: lastDefined(inputs.map((p) => p.approval)) ?? null,
  })
}

/**
 * Lightweight enforcer: exposes `canX` predicates that return a structured
 * decision. The runtime calls these before performing any privileged action.
 */
export class TrustEnforcer {
  constructor(readonly policy: ResolvedPolicy) {}

  canCallTool(toolId: string): EnforceDecision {
    if (matches(this.policy.deniedTools, toolId)) {
      return { allow: false, reason: 'in-denylist', dimension: 'tool' }
    }
    if (!matches(this.policy.allowedTools, toolId)) {
      return { allow: false, reason: 'not-in-allowlist', dimension: 'tool' }
    }
    return { allow: true }
  }

  canExec(binary: string): EnforceDecision {
    if (!this.policy.allowedExecutables.has(binary)) {
      return { allow: false, reason: 'not-in-allowlist', dimension: 'executable' }
    }
    return { allow: true }
  }

  canAttachMcpServer(serverId: string): EnforceDecision {
    if (!this.policy.allowedMcpServers.has(serverId)) {
      return { allow: false, reason: 'not-in-allowlist', dimension: 'mcp' }
    }
    return { allow: true }
  }

  canLoadSkill(skillId: string): EnforceDecision {
    if (!this.policy.allowedSkills.has(skillId)) {
      return { allow: false, reason: 'not-in-allowlist', dimension: 'skill' }
    }
    return { allow: true }
  }

  canAccessSecret(name: string): EnforceDecision {
    if (!this.policy.allowedSecrets.has(name)) {
      return { allow: false, reason: 'not-in-allowlist', dimension: 'secret' }
    }
    return { allow: true }
  }

  canFetch(host: string): EnforceDecision {
    const policy = this.policy.networkEgress
    if (policy === 'allow') return { allow: true }
    if (policy === 'deny') return { allow: false, reason: 'no-policy', dimension: 'network' }
    if (typeof policy === 'object' && policy.allowHosts.includes(host)) {
      return { allow: true }
    }
    return { allow: false, reason: 'host-not-allowed', dimension: 'network' }
  }

  canRead(path: string): EnforceDecision {
    return this.canFsAccess(path, this.policy.fsRead, 'fs.read')
  }

  canWrite(path: string): EnforceDecision {
    return this.canFsAccess(path, this.policy.fsWrite, 'fs.write')
  }

  private canFsAccess(
    path: string,
    roots: ReadonlySet<string> | undefined,
    dimension: 'fs.read' | 'fs.write',
  ): EnforceDecision {
    if (!roots || roots.size === 0)
      return { allow: false, reason: 'path-not-in-allowlist', dimension }
    for (const rawRoot of roots) {
      const root = rawRoot.endsWith('/') ? rawRoot.slice(0, -1) : rawRoot
      if (path === root || path.startsWith(`${root}/`)) {
        return { allow: true }
      }
    }
    return { allow: false, reason: 'path-not-in-allowlist', dimension }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function intersectStrings(
  arrays: ReadonlyArray<readonly string[] | undefined>,
): ReadonlySet<string> {
  const present = arrays.filter((a): a is readonly string[] => a !== undefined)
  if (present.length === 0) return new Set()
  let acc: Set<string> = new Set(present[0])
  for (let i = 1; i < present.length; i++) {
    const next = new Set<string>()
    const a = present[i]
    if (a !== undefined) {
      for (const item of a) {
        if (acc.has(item)) next.add(item)
      }
    }
    acc = next
  }
  return acc
}

function intersectToolMatchers(
  matchers: ReadonlyArray<ToolMatcher | undefined>,
): ResolvedToolMatcher {
  const present = matchers.filter((m): m is ToolMatcher => m !== undefined)
  if (present.length === 0) return EMPTY_MATCHER

  const normalized = present.map(normalizeToolMatcher)
  let acc = normalized[0] ?? EMPTY_MATCHER
  for (let i = 1; i < normalized.length; i++) {
    const next = normalized[i]
    if (next === undefined) continue
    acc = {
      exact: new Set([...acc.exact].filter((x) => next.exact.has(x))),
      prefixes: acc.prefixes.filter((p) => next.prefixes.includes(p)),
      star: acc.star && next.star,
    }
  }
  return Object.freeze(acc)
}

function unionToolMatchers(matchers: ReadonlyArray<ToolMatcher | undefined>): ResolvedToolMatcher {
  const acc = {
    exact: new Set<string>(),
    prefixes: [] as string[],
    star: false,
  }
  for (const m of matchers) {
    if (m === undefined) continue
    const n = normalizeToolMatcher(m)
    for (const x of n.exact) acc.exact.add(x)
    for (const p of n.prefixes) {
      if (!acc.prefixes.includes(p)) acc.prefixes.push(p)
    }
    if (n.star) acc.star = true
  }
  return Object.freeze({
    exact: acc.exact,
    prefixes: Object.freeze(acc.prefixes),
    star: acc.star,
  })
}

function normalizeToolMatcher(m: ToolMatcher): ResolvedToolMatcher {
  if (Array.isArray(m)) {
    const exact = new Set<string>()
    const prefixes: string[] = []
    let star = false
    for (const id of m as readonly string[]) {
      if (id === '*') {
        star = true
      } else if (id.endsWith('.*')) {
        prefixes.push(id.slice(0, -1)) // keep the dot
      } else {
        exact.add(id)
      }
    }
    return Object.freeze({ exact, prefixes: Object.freeze(prefixes), star })
  }
  const obj = m as { exact?: readonly string[]; prefixes?: readonly string[]; star?: boolean }
  return Object.freeze({
    exact: new Set(obj.exact ?? []),
    prefixes: Object.freeze([...(obj.prefixes ?? [])]),
    star: obj.star ?? false,
  })
}

function stripProfile(permissions: AgentPermissions | undefined): AgentPermissions | undefined {
  if (permissions === undefined) return undefined
  const { profile: _profile, ...rest } = permissions
  return rest
}

function matches(matcher: ResolvedToolMatcher, id: string): boolean {
  if (matcher.star) return true
  if (matcher.exact.has(id)) return true
  for (const p of matcher.prefixes) {
    if (id.startsWith(p)) return true
  }
  return false
}

function intersectNetwork(policies: ReadonlyArray<NetworkPolicy | undefined>): NetworkPolicy {
  const present = policies.filter((p): p is NetworkPolicy => p !== undefined)
  if (present.length === 0) return 'deny'
  let acc: NetworkPolicy = present[0] ?? 'deny'
  for (let i = 1; i < present.length; i++) {
    const next = present[i]
    if (next === undefined) continue
    acc = narrowNetwork(acc, next)
  }
  return acc
}

function narrowNetwork(a: NetworkPolicy, b: NetworkPolicy): NetworkPolicy {
  if (a === 'deny' || b === 'deny') return 'deny'
  if (a === 'allow') return b
  if (b === 'allow') return a
  // Both are { allowHosts: [...] }; intersect.
  const intersected = a.allowHosts.filter((h) => b.allowHosts.includes(h))
  return { allowHosts: Object.freeze(intersected) }
}

function lastDefined<T>(arr: ReadonlyArray<T | undefined>): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== undefined) return arr[i]
  }
  return undefined
}

/**
 * Returns a `fetch` wrapper that enforces the network egress policy from a
 * resolved permission policy. Every outbound request is checked against the
 * policy before the real `fetch` is called; denied requests throw
 * `PermissionDeniedError`.
 *
 * Use this to build `BackendContext.fetch` when running an agent step that
 * declares a network policy.
 *
 * @param policy  The resolved policy for the current step.
 * @param events  Optional callback to emit `permission.denied` events.
 * @param base    Base fetch implementation (defaults to `globalThis.fetch`).
 */
export function createPolicyFetch(
  enforcer: TrustEnforcer,
  events?: {
    publish: (event: {
      type: 'permission.denied'
      runId: string
      stepId: string
      dimension: PermissionDimension
      detail: string
      at: number
    }) => void
    runId: string
    stepId: string
  },
  base: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async function policyFetch(input, init) {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      // Unparseable URL — deny to be safe.
      throw new PermissionDeniedError(`network request denied: URL could not be parsed: ${url}`)
    }
    const decision = enforcer.canFetch(host)
    if (!decision.allow) {
      const detail = `network request to "${host}" denied (${decision.reason})`
      if (events !== undefined) {
        events.publish({
          type: 'permission.denied',
          runId: events.runId,
          stepId: events.stepId,
          dimension: 'network',
          detail,
          at: Date.now(),
        })
      }
      throw new PermissionDeniedError(detail)
    }
    return base(input, init)
  }
}
